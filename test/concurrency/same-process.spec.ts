import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl } from '../support/fixtures';
import { createWallet, submit, wager } from '../support/wagering';

/**
 * Real parallelism against one Nest app and a real connection pool: requests
 * race on the same rows in Postgres. The multi-process suite repeats these
 * across three OS processes.
 */
describe('concurrency, one instance (real Postgres)', () => {
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

  it('README 8: balance 100.00, two simultaneous 80.00 bets -> one PROCESSED, one REJECTED, 20.00, one debit', async () => {
    const w = await createWallet(app, '100.00');
    const [a, b] = await Promise.all([submit(app, wager(w, 'BET', '80.00')), submit(app, wager(w, 'BET', '80.00'))]);
    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect([a, b].find((r) => r.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const [wallet] = await sql`select balance::text from wallets where id = ${w.walletId}`;
    expect(wallet.balance).toBe('20.00');
    const debits = await sql`select 1 from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`;
    expect(debits).toHaveLength(1);
  });

  it('the same bet sent 50 times in parallel -> exactly one debit, 49 replays of the same answer', async () => {
    const w = await createWallet(app, '100.00');
    const bet = wager(w, 'BET', '10.00');
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(app, bet)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.every((r) => r.body.balance.amount === '90.00')).toBe(true);

    const debits = await sql`select 1 from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`;
    expect(debits).toHaveLength(1);
    const [wallet] = await sql`select balance::text from wallets where id = ${w.walletId}`;
    expect(wallet.balance).toBe('90.00');
  });

  it('hot wallet: 40 different bets race for 100.00 -> never negative, ledger matches', async () => {
    const w = await createWallet(app, '100.00');
    const responses = await Promise.all(Array.from({ length: 40 }, () => submit(app, wager(w, 'BET', '7.00'))));
    const processed = responses.filter((r) => r.body.status === 'PROCESSED');
    expect(processed).toHaveLength(14); // floor(100 / 7)
    expect(responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(26);
    const [wallet] = await sql`select balance::text, version::int from wallets where id = ${w.walletId}`;
    expect(wallet).toEqual({ balance: '2.00', version: 15 });
  });

  it('different wallets in parallel do not block each other and all apply', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(app, '50.00')));
    const responses = await Promise.all(
      wallets.flatMap((w) => [submit(app, wager(w, 'BET', '20')), submit(app, wager(w, 'WIN', '5')), submit(app, wager(w, 'BET', '10'))]),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const balances = await sql`select balance::text from wallets`;
    expect(balances.every((b: { balance: string }) => b.balance === '25.00')).toBe(true);
    expect(brl('25.00').amount).toBe('25.00');
  });
});
