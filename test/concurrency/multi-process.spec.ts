import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl, newPlayerId } from '../support/fixtures';
import { type Instance, eventually, spawnInstance } from '../support/spawn';
import { WAGER_DLQ, WAGER_QUEUE, drainQueue, queueDepth, sendWagerMessage, testSqsClient } from '../support/sqs';
import type { WagerBody, WalletHandle } from '../support/wagering';

/**
 * README 13, concurrency: three OS processes (`bun src/main.ts`), each with its
 * own connection pool and every role (api, consumer, workers), sharing one
 * Postgres and one LocalStack. Requests are spread round-robin, so the races
 * happen between processes, not inside one event loop.
 */
const FAST = {
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
  SQS_WAIT_TIME_SECONDS: '1',
  DATABASE_POOL_MAX: '8',
};

describe('three instances (separate processes)', () => {
  const sql = openAdminSql();
  const sqs = testSqsClient();
  let instances: Instance[] = [];

  const start = () => Promise.all([0, 1, 2].map(() => spawnInstance({ roles: 'api,consumer,workers', env: FAST })));
  const at = (i: number) => instances[i % instances.length]!;

  async function post(i: number, path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${at(i).url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { balance?: { amount: string } } };
  }

  async function createWallet(i: number, amount: string): Promise<WalletHandle> {
    const playerId = newPlayerId();
    const res = await post(i, '/wallets', { playerId, initialBalance: brl(amount) });
    expect(res.status).toBe(201);
    return { walletId: String(res.body.id), playerId };
  }

  function bet(w: WalletHandle, kind: string, amount: string, extra: Partial<WagerBody> = {}): WagerBody {
    return {
      providerId: 'provider-a', externalTransactionId: `tx-${uuidv7()}`, playerId: w.playerId, walletId: w.walletId,
      roundId: 'round-1', gameId: 'fortune-chimp', kind, money: brl(amount), ...extra,
    };
  }

  const submitVia = (i: number, body: WagerBody) =>
    post(i, '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

  /** Every message consumed, every event published, nothing waiting for a reference. */
  async function settled(): Promise<void> {
    await eventually(async () => {
      const [{ outbox, pending }] = await sql`
        select (select count(*)::int from outbox_messages where published_at is null) as outbox,
               (select count(*)::int from wager_transactions where status = 'PENDING_REFERENCE') as pending`;
      return outbox === 0 && pending === 0 && (await queueDepth(sqs, WAGER_QUEUE)) === 0;
    }, 60_000, 250);
  }

  beforeAll(async () => {
    instances = await start();
  });
  beforeEach(async () => {
    await resetDatabase(sql);
    await drainQueue(sqs, WAGER_QUEUE, 1);
    await drainQueue(sqs, WAGER_DLQ, 1);
  });
  afterEach(() => assertLedgerInvariant(sql));
  afterAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    await sql.close();
    sqs.destroy();
  });

  it('1. the same bet 50 times in parallel across 3 processes -> one debit', async () => {
    const w = await createWallet(0, '100.00');
    const body = bet(w, 'BET', '10.00');
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submitVia(i, body)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(await sql`select 1 from wallet_ledger_entries where direction = 'DEBIT'`).toHaveLength(1);
  });

  it('2. README 8 across processes: 100.00 and two 80.00 bets -> one PROCESSED, one REJECTED, 20.00', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await createWallet(round, '100.00');
      const [a, b] = await Promise.all([submitVia(round, bet(w, 'BET', '80.00')), submitVia(round + 1, bet(w, 'BET', '80.00'))]);
      expect([a.body.status, b.body.status].sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['PROCESSED', 'REJECTED']);
      const [row] = await sql`select balance::text from wallets where id = ${w.walletId}`;
      expect(row.balance).toBe('20.00');
      expect(await sql`select 1 from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`).toHaveLength(1);
    }
  });

  it('3. distinct wallets in parallel all apply; hot wallet never goes negative', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => createWallet(i, '50.00')));
    const hot = await createWallet(0, '100.00');
    const responses = await Promise.all([
      ...wallets.flatMap((w, i) => [submitVia(i, bet(w, 'BET', '20')), submitVia(i + 1, bet(w, 'WIN', '5')), submitVia(i + 2, bet(w, 'BET', '10'))]),
      ...Array.from({ length: 45 }, (_, i) => submitVia(i, bet(hot, 'BET', '3.00'))),
    ]);
    expect(responses.every((r) => r.status === 200 || r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    const balances = await sql`select id, balance::text from wallets`;
    for (const b of balances) expect(b.balance).toBe(b.id === hot.walletId ? '1.00' : '25.00'); // 100 - 33 * 3
  });

  it('4. SQS: the same message delivered to 3 consumers in different processes applies once', async () => {
    const w = await createWallet(0, '100.00');
    const body = bet(w, 'BET', '7');
    const envelope = {
      messageId: `msg-${uuidv7()}`, type: 'WagerTransactionRequested' as const, occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
    };
    // Different groups and dedup ids: the broker lets all copies through at once.
    for (let i = 0; i < 6; i++) await sendWagerMessage(sqs, envelope, { groupId: `copy-${i}` });
    await settled();
    expect(await sql`select 1 from wallet_ledger_entries where direction = 'DEBIT'`).toHaveLength(1);
    expect(await sql`select 1 from inbox_messages`).toHaveLength(1);
  });

  it('5/6/7. reversal before its reference (via SQS), resolved by workers; every event published once', async () => {
    const w = await createWallet(0, '100.00');
    const theBet = bet(w, 'BET', '25');
    const rollback = bet(w, 'ROLLBACK', '25', { referenceExternalTransactionId: theBet.externalTransactionId });
    await sendWagerMessage(sqs, {
      messageId: `msg-${uuidv7()}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { ...rollback, idempotencyKey: `${rollback.providerId}:${rollback.externalTransactionId}` },
    });
    await eventually(async () => (await sql`select 1 from wager_transactions where kind = 'ROLLBACK' and status = 'PENDING_REFERENCE'`).length === 1);

    expect((await submitVia(1, theBet)).status).toBe(200);
    await settled();

    const [rb] = await sql`select status from wager_transactions where kind = 'ROLLBACK'`;
    expect(rb.status).toBe('PROCESSED');
    const [row] = await sql`select balance::text from wallets where id = ${w.walletId}`;
    expect(row.balance).toBe('100.00');
    // Published by whichever of the 3 publishers claimed them, each exactly once in the outbox.
    const [{ unpublished, total }] = await sql`select count(*) filter (where published_at is null)::int as unpublished, count(*)::int as total from outbox_messages`;
    expect(unpublished).toBe(0);
    expect(total).toBeGreaterThanOrEqual(7);
  });

  it('8. all instances killed mid-traffic (SIGKILL), restarted: providers retry, final state is consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => createWallet(i, '1000.00')));
    const bodies = Array.from({ length: 300 }, (_, i) => bet(wallets[i % wallets.length]!, 'BET', '1.00'));
    const sqsBodies = Array.from({ length: 30 }, (_, i) => bet(wallets[i % wallets.length]!, 'WIN', '2.00'));

    // Traffic in flight...
    const inFlight = bodies.map((b, i) => submitVia(i, b).catch(() => null));
    for (const b of sqsBodies) {
      await sendWagerMessage(sqs, {
        messageId: `msg-${b.externalTransactionId}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
        data: { ...b, idempotencyKey: `${b.providerId}:${b.externalTransactionId}` },
      });
    }
    await Bun.sleep(150);
    // ...and every process dies at once, without any shutdown hook.
    await Promise.all(instances.map((i) => i.stop('SIGKILL')));
    const firstAnswers = await Promise.all(inFlight);
    // The crash must really cut requests in flight, or this scenario proves nothing.
    expect(firstAnswers.filter((a) => a === null).length).toBeGreaterThan(0);

    instances = await start();

    // Providers retry everything they sent (at-least-once delivery).
    const retries = await Promise.all(bodies.map((b, i) => submitVia(i, b)));
    expect(retries.every((r) => r.status === 200)).toBe(true);
    await settled();

    // Whatever was answered before the crash is what the retry returns.
    firstAnswers.forEach((first, i) => {
      if (first && first.status === 200) {
        expect(retries[i]!.body.transactionId).toBe(first.body.transactionId);
        expect(retries[i]!.body.balance).toEqual(first.body.balance);
      }
    });

    // Exactly one transaction and one ledger entry per operation, nothing lost.
    const [{ bets, wins, entries }] = await sql`
      select count(*) filter (where kind = 'BET')::int as bets, count(*) filter (where kind = 'WIN')::int as wins,
             (select count(*)::int from wallet_ledger_entries where direction = 'DEBIT') as entries
        from wager_transactions`;
    expect(bets).toBe(300);
    expect(wins).toBe(30);
    expect(entries).toBe(300);
    const [{ total }] = await sql`select sum(balance)::text as total from wallets`;
    expect(total).toBe('9760.00'); // 10 x 1000 - 300 x 1 + 30 x 2
  });
});
