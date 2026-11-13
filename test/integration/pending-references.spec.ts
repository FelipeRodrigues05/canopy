import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ResolvePendingReferencesUseCase } from '../../src/modules/wagering/application/resolve-pending-references.use-case';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl } from '../support/fixtures';
import { eventually } from '../support/spawn';
import { createWallet, submit, wager } from '../support/wagering';

/**
 * .env.test shortens the policy: backoff 20 ms .. 100 ms, 4 attempts
 * (production: 1 s .. 5 min, 10 attempts).
 */
describe('pending references (real Postgres)', () => {
  const sql = openAdminSql();
  let app: INestApplication;
  let resolver: ResolvePendingReferencesUseCase;

  beforeAll(async () => {
    app = await createTestApp();
    resolver = app.get(ResolvePendingReferencesUseCase);
  });
  beforeEach(() => resetDatabase(sql));
  afterEach(() => assertLedgerInvariant(sql));
  afterAll(async () => {
    await app.close();
    await sql.close();
  });

  const row = async (id: string) =>
    (await sql`select status, failure_code, reference_attempts, reference_transaction_id from wager_transactions where id = ${id}`)[0];
  const balanceOf = async (walletId: string) => (await sql`select balance::text from wallets where id = ${walletId}`)[0].balance;

  /** Runs the worker until the transaction leaves PENDING_REFERENCE. */
  async function resolveUntilDecided(id: string): Promise<void> {
    await eventually(async () => {
      await resolver.resolveDue();
      return (await row(id)).status !== 'PENDING_REFERENCE';
    }, 10_000, 30);
  }

  it('ROLLBACK delivered before its BET is applied once the BET arrives', async () => {
    const w = await createWallet(app, '100.00');
    const bet = wager(w, 'BET', '40');
    const rollback = await submit(app, wager(w, 'ROLLBACK', '40', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.status).toBe(202);

    const betRes = await submit(app, bet);
    expect(betRes.body.balance).toEqual(brl('60.00'));

    await resolveUntilDecided(rollback.body.transactionId);
    expect(await row(rollback.body.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: betRes.body.transactionId,
    });
    expect(await balanceOf(w.walletId)).toBe('100.00');
    const events = await sql`select event_type from outbox_messages where payload->'data'->>'transactionId' = ${rollback.body.transactionId} order by occurred_at, event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('a replay of the parked request still answers its original 202 (A5)', async () => {
    const w = await createWallet(app, '100.00');
    const bet = wager(w, 'BET', '10');
    const refund = wager(w, 'REFUND', '10', { referenceExternalTransactionId: bet.externalTransactionId });
    const first = await submit(app, refund);
    await submit(app, bet);
    await resolveUntilDecided(first.body.transactionId);

    const replay = await submit(app, refund);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('the arrival of the reference makes the waiting transaction due immediately', async () => {
    const w = await createWallet(app, '100.00');
    const bet = wager(w, 'BET', '10');
    const refund = await submit(app, wager(w, 'REFUND', '10', { referenceExternalTransactionId: bet.externalTransactionId }));
    await sql`update wager_transactions set next_retry_at = now() + interval '1 hour' where id = ${refund.body.transactionId}`;

    await submit(app, bet);
    const [{ due }] = await sql`select next_retry_at <= now() as due from wager_transactions where id = ${refund.body.transactionId}`;
    expect(due).toBe(true);
    await resolver.resolveDue();
    expect((await row(refund.body.transactionId)).status).toBe('PROCESSED');
  });

  it('reference never arrives: REJECTED REFERENCE_NOT_FOUND after the attempt limit, with its event', async () => {
    const w = await createWallet(app, '100.00');
    const res = await submit(app, wager(w, 'ROLLBACK', '10', { referenceExternalTransactionId: 'ghost-bet' }));
    await resolveUntilDecided(res.body.transactionId);

    expect(await row(res.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 3 });
    const [event] = await sql`select payload from outbox_messages where event_type = 'WagerTransactionRejected'
                               and payload->'data'->>'transactionId' = ${res.body.transactionId}`;
    expect(event.payload.data.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await balanceOf(w.walletId)).toBe('100.00');
  });

  it('each failed lookup schedules the next one with exponential backoff', async () => {
    const w = await createWallet(app, '100.00');
    const res = await submit(app, wager(w, 'REFUND', '10', { referenceExternalTransactionId: 'late' }));
    // .env.test: base 20 ms -> attempt n waits 20 * 2^n ms (cap 100 ms)
    for (const [attempt, expectedMs] of [[1, 40], [2, 80]] as const) {
      await sql`update wager_transactions set next_retry_at = now() where id = ${res.body.transactionId}`;
      const before = Date.now();
      await resolver.resolveDue();
      const [r] = await sql`select reference_attempts, next_retry_at from wager_transactions where id = ${res.body.transactionId}`;
      expect(r.reference_attempts).toBe(attempt);
      // Scheduled from a clock read after `before`: the gap is at least the delay.
      const gap = new Date(r.next_retry_at).getTime() - before;
      expect(gap).toBeGreaterThanOrEqual(expectedMs);
      expect(gap).toBeLessThan(expectedMs + 2000);
    }
  });

  it('reference arrives but is rejected: the waiting REFUND ends REFERENCE_NOT_PROCESSED', async () => {
    const w = await createWallet(app, '5.00');
    const bet = wager(w, 'BET', '10'); // more than the balance
    const refund = await submit(app, wager(w, 'REFUND', '10', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect((await submit(app, bet)).body.failureCode).toBe('INSUFFICIENT_FUNDS');

    await resolveUntilDecided(refund.body.transactionId);
    expect(await row(refund.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
    expect(await balanceOf(w.walletId)).toBe('5.00');
  });

  it('chain: ROLLBACK of a REFUND of a BET, delivered in reverse order, settles to the right balance', async () => {
    const w = await createWallet(app, '100.00');
    const bet = wager(w, 'BET', '30');
    const refund = wager(w, 'REFUND', '30', { referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = wager(w, 'ROLLBACK', '30', { referenceExternalTransactionId: refund.externalTransactionId });

    const rb = await submit(app, rollback);
    const rf = await submit(app, refund);
    await submit(app, bet);
    await resolveUntilDecided(rf.body.transactionId);
    await resolveUntilDecided(rb.body.transactionId);

    expect((await row(rf.body.transactionId)).status).toBe('PROCESSED');
    expect((await row(rb.body.transactionId)).status).toBe('PROCESSED');
    // 100 - 30 (bet) + 30 (refund) - 30 (rollback of the refund) = 70
    expect(await balanceOf(w.walletId)).toBe('70.00');
  });

  it('two workers on separate instances resolve each pending transaction exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(app, '100.00')));
    const bets = wallets.flatMap((w) => [wager(w, 'BET', '10'), wager(w, 'BET', '5'), wager(w, 'BET', '1')]);
    for (const bet of bets) {
      const w = { walletId: bet.walletId, playerId: bet.playerId };
      await submit(app, wager(w, 'REFUND', bet.money.amount, { referenceExternalTransactionId: bet.externalTransactionId }));
    }
    await Promise.all(bets.map((b) => submit(app, b)));

    const second = await createTestApp();
    try {
      const other = second.get(ResolvePendingReferencesUseCase);
      await eventually(async () => {
        await Promise.all([resolver.resolveDue(), other.resolveDue()]);
        const [{ n }] = await sql`select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`;
        return n === 0;
      }, 15_000, 0);
    } finally {
      await second.close();
    }

    const [{ refunds }] = await sql`select count(*)::int as refunds from wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`;
    expect(refunds).toBe(30);
    const credits = await sql`select count(*)::int as n from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.kind = 'REFUND'`;
    expect(credits[0].n).toBe(30);
    const balances = await sql`select balance::text from wallets`;
    expect(balances.every((b: { balance: string }) => b.balance === '100.00')).toBe(true);
  });
});
