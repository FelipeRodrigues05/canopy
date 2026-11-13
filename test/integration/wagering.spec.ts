import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl } from '../support/fixtures';
import { createWallet, submit, wager } from '../support/wagering';

describe('POST /wagering/transactions (real Postgres)', () => {
  let app: INestApplication;
  const sql = openAdminSql();

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(() => resetDatabase(sql));
  afterEach(() => assertLedgerInvariant(sql));
  afterAll(async () => {
    await app.close();
    await sql.close();
  });

  const balanceOf = async (walletId: string) =>
    (await sql`select balance::text from wallets where id = ${walletId}`)[0].balance as string;
  const eventsOf = async (transactionId: string) =>
    (await sql`select event_type from outbox_messages where payload->'data'->>'transactionId' = ${transactionId} order by event_type`).map(
      (r: { event_type: string }) => r.event_type,
    );

  describe('BET', () => {
    it('debits, writes one DEBIT entry and both events atomically', async () => {
      const w = await createWallet(app, '1000.00');
      const res = await submit(app, wager(w, 'BET', '25'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'PROCESSED', balance: brl('975.00'), walletVersion: 2, idempotentReplay: false });

      const entries = await sql`select direction, amount::text, balance_after::text, sequence::int from wallet_ledger_entries
                                 where transaction_id = ${res.body.transactionId}`;
      expect(entries).toEqual([{ direction: 'DEBIT', amount: '25.00', balance_after: '975.00', sequence: 2 }]);
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    });

    it('insufficient funds: 422, persisted REJECTED, no ledger entry, no balance event', async () => {
      const w = await createWallet(app, '10.00');
      const res = await submit(app, wager(w, 'BET', '10.01'));
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('10.00') });

      const [row] = await sql`select status, failure_code from wager_transactions where id = ${res.body.transactionId}`;
      expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
      expect(await sql`select 1 from wallet_ledger_entries where transaction_id = ${res.body.transactionId}`).toHaveLength(0);
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionRejected']);
      expect(await balanceOf(w.walletId)).toBe('10.00');
    });
  });

  it('WIN credits; LOSS moves nothing but is PROCESSED with its event', async () => {
    const w = await createWallet(app, '50.00');
    const bet = wager(w, 'BET', '20');
    await submit(app, bet);
    const win = await submit(app, wager(w, 'WIN', '45.50', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.status).toBe(200);
    expect(win.body.balance).toEqual(brl('75.50'));

    const loss = await submit(app, wager(w, 'LOSS', '20'));
    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: brl('75.50'), walletVersion: 3 });
    expect(await sql`select 1 from wallet_ledger_entries where transaction_id = ${loss.body.transactionId}`).toHaveLength(0);
    expect(await eventsOf(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  describe('REFUND and ROLLBACK', () => {
    it('REFUND gives a BET back once; any second reversal is ALREADY_REVERSED (A3)', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '30');
      await submit(app, bet);
      const ref = { referenceExternalTransactionId: bet.externalTransactionId };

      const refund = await submit(app, wager(w, 'REFUND', '30', ref));
      expect(refund.status).toBe(200);
      expect(refund.body.balance).toEqual(brl('100.00'));

      const again = await submit(app, wager(w, 'REFUND', '30', ref));
      expect(again.status).toBe(422);
      expect(again.body.failureCode).toBe('ALREADY_REVERSED');
      const rollback = await submit(app, wager(w, 'ROLLBACK', '30', ref));
      expect(rollback.body.failureCode).toBe('ALREADY_REVERSED');
      expect(await balanceOf(w.walletId)).toBe('100.00');
    });

    it('REFUND with another amount is AMOUNT_MISMATCH; REFUND of a WIN is INVALID_REFERENCE_KIND', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '30');
      await submit(app, bet);
      const partial = await submit(app, wager(w, 'REFUND', '15', { referenceExternalTransactionId: bet.externalTransactionId }));
      expect(partial.body.failureCode).toBe('AMOUNT_MISMATCH');

      const win = wager(w, 'WIN', '5');
      await submit(app, win);
      const bad = await submit(app, wager(w, 'REFUND', '5', { referenceExternalTransactionId: win.externalTransactionId }));
      expect(bad.body.failureCode).toBe('INVALID_REFERENCE_KIND');
    });

    it('ROLLBACK of a BET credits, ROLLBACK of a WIN debits', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '40');
      await submit(app, bet);
      const rb = await submit(app, wager(w, 'ROLLBACK', '40', { referenceExternalTransactionId: bet.externalTransactionId }));
      expect(rb.body.balance).toEqual(brl('100.00'));

      const win = wager(w, 'WIN', '60');
      await submit(app, win);
      const rbWin = await submit(app, wager(w, 'ROLLBACK', '60', { referenceExternalTransactionId: win.externalTransactionId }));
      expect(rbWin.status).toBe(200);
      expect(rbWin.body.balance).toEqual(brl('100.00'));
    });

    it('ROLLBACK that would overdraw is REVERSAL_WOULD_OVERDRAW (not INSUFFICIENT_FUNDS) and stays auditable', async () => {
      const w = await createWallet(app, '0.00');
      const win = wager(w, 'WIN', '50');
      await submit(app, win);
      await submit(app, wager(w, 'BET', '30')); // player spent part of the win
      const rb = await submit(app, wager(w, 'ROLLBACK', '50', { referenceExternalTransactionId: win.externalTransactionId }));
      expect(rb.status).toBe(422);
      expect(rb.body).toMatchObject({ failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: brl('20.00') });
      const [row] = await sql`select status, failure_code, reference_transaction_id is not null as linked from wager_transactions where id = ${rb.body.transactionId}`;
      expect(row).toEqual({ status: 'REJECTED', failure_code: 'REVERSAL_WOULD_OVERDRAW', linked: true });
    });

    it('reference from another round is REFERENCE_MISMATCH', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '10');
      await submit(app, bet);
      const res = await submit(app, wager(w, 'REFUND', '10', { roundId: 'other-round', referenceExternalTransactionId: bet.externalTransactionId }));
      expect(res.body.failureCode).toBe('REFERENCE_MISMATCH');
    });

    it('reversal before its reference: 202 PENDING_REFERENCE with event, no money moved', async () => {
      const w = await createWallet(app, '100.00');
      const res = await submit(app, wager(w, 'ROLLBACK', '10', { referenceExternalTransactionId: 'bet-not-here-yet' }));
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00') });
      const [row] = await sql`select status, next_retry_at is not null as scheduled from wager_transactions where id = ${res.body.transactionId}`;
      expect(row).toEqual({ status: 'PENDING_REFERENCE', scheduled: true });
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionPendingReference']);
    });
  });

  describe('wallet checks', () => {
    it('unknown wallet: 422 WALLET_NOT_FOUND and nothing persisted (A2)', async () => {
      const w = await createWallet(app, '1.00');
      const res = await submit(app, wager({ ...w, walletId: '0192f291-27dd-7d3f-8071-5f8685deef37' }, 'BET', '1'));
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'WALLET_NOT_FOUND', category: 'BUSINESS', retryable: false });
      expect(await sql`select 1 from wager_transactions where kind <> 'OPENING'`).toHaveLength(0);
    });

    it('wallet of another player and currency mismatch are rejected', async () => {
      const w = await createWallet(app, '100.00');
      const other = await submit(app, wager({ ...w, playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' }, 'BET', '1'));
      expect(other.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
      const usd = await submit(app, wager(w, 'BET', '1', { money: { amount: '1.00', currency: 'USD' } }));
      expect(usd.body.failureCode).toBe('CURRENCY_MISMATCH');
    });
  });

  describe('idempotency', () => {
    it('identical replay returns the original answer, with the balance observed then', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '10');
      const first = await submit(app, bet);
      await submit(app, wager(w, 'BET', '50')); // balance moves on

      const replay = await submit(app, bet);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(replay.body.balance).toEqual(brl('90.00'));
      expect(await balanceOf(w.walletId)).toBe('40.00');
    });

    it('replay of a rejection is the same 422', async () => {
      const w = await createWallet(app, '1.00');
      const bet = wager(w, 'BET', '5');
      const first = await submit(app, bet);
      const replay = await submit(app, bet);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('a replay with "10" instead of "10.00" is the same request', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '10.00');
      await submit(app, bet);
      const replay = await submit(app, { ...bet, money: brl('10') });
      expect(replay.body.idempotentReplay).toBe(true);
    });

    it('same key with a different payload is 409 IDEMPOTENCY_CONFLICT, never a replay', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '10');
      await submit(app, bet);
      const res = await submit(app, { ...bet, money: brl('11') });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', category: 'CONFLICT', retryable: false });
      expect(await balanceOf(w.walletId)).toBe('90.00');
    });

    it('same external id under another key is 409', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '10');
      await submit(app, bet, 'key-1');
      const res = await submit(app, bet, 'key-2');
      expect(res.status).toBe(409);
      expect(await balanceOf(w.walletId)).toBe('90.00');
    });

    it('keys are scoped per provider (A1)', async () => {
      const w = await createWallet(app, '100.00');
      expect((await submit(app, wager(w, 'BET', '1', { providerId: 'provider-a' }), 'shared-key')).body.idempotentReplay).toBe(false);
      expect((await submit(app, wager(w, 'BET', '1', { providerId: 'provider-b' }), 'shared-key')).body.idempotentReplay).toBe(false);
      expect(await balanceOf(w.walletId)).toBe('98.00');
    });
  });

  describe('invalid requests (400)', () => {
    it('missing Idempotency-Key', async () => {
      const w = await createWallet(app);
      const res = await request(app.getHttpServer()).post('/wagering/transactions').send(wager(w, 'BET', '1'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    });

    it.each([
      ['OPENING kind (internal only)', { kind: 'OPENING' }],
      ['unknown kind', { kind: 'JACKPOT' }],
      ['REFUND without reference', { kind: 'REFUND' }],
      ['negative money', { money: brl('-1') }],
      ['3 decimals', { money: brl('1.123') }],
      ['number money', { money: { amount: 1, currency: 'BRL' } }],
      ['NaN', { money: brl('NaN') }],
      ['Infinity', { money: brl('Infinity') }],
      ['empty amount', { money: brl('') }],
    ])('%s', async (_label, change) => {
      const w = await createWallet(app);
      const res = await submit(app, { ...wager(w, 'BET', '1'), ...(change as object) } as ReturnType<typeof wager>);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    });
  });
});
