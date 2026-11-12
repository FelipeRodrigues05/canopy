import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionRequestedConsumer } from '../../src/modules/wagering/presentation/wager-transaction-requested.consumer';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl } from '../support/fixtures';
import { eventually, spawnInstance } from '../support/spawn';
import { ChangeMessageVisibilityCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import {
  type RequestedEnvelope,
  WAGER_DLQ,
  WAGER_QUEUE,
  drainQueue,
  queueDepth,
  queueUrl,
  sendWagerMessage,
  testSqsClient,
} from '../support/sqs';
import { type WalletHandle, createWallet, submit, wager } from '../support/wagering';

describe('SQS consumer (real Postgres + LocalStack)', () => {
  const sql = openAdminSql();
  const sqs = testSqsClient();
  let app: INestApplication;
  let consumer: WagerTransactionRequestedConsumer;

  beforeAll(async () => {
    app = await createTestApp();
    consumer = app.get(WagerTransactionRequestedConsumer);
  });
  beforeEach(async () => {
    await resetDatabase(sql);
    await drainQueue(sqs, WAGER_QUEUE, 1);
    await drainQueue(sqs, WAGER_DLQ, 1);
  });
  afterEach(() => assertLedgerInvariant(sql));
  afterAll(async () => {
    await app.close();
    await sql.close();
    sqs.destroy();
  });

  function envelope(w: WalletHandle, kind: string, amount: string, extra: Record<string, unknown> = {}): RequestedEnvelope {
    const body = wager(w, kind, amount);
    return {
      messageId: `msg-${uuidv7()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}`, ...extra },
    };
  }

  /**
   * Polls until the queue is really empty, in-flight messages included. A
   * message can be invisible for a while without anyone working on it (e.g.
   * handed to a long poll whose client went away), so "two empty receives"
   * is not proof that everything was handled.
   */
  async function consumeAll(): Promise<void> {
    await eventually(async () => {
      await consumer.pollOnce();
      return (await queueDepth(sqs, WAGER_QUEUE)) === 0;
    }, 30_000, 0);
  }

  const balanceOf = async (walletId: string) => (await sql`select balance::text from wallets where id = ${walletId}`)[0].balance;

  it('processes a message with the same use case as HTTP, writes the inbox and acks', async () => {
    const w = await createWallet(app, '100.00');
    const msg = envelope(w, 'BET', '25');
    await sendWagerMessage(sqs, msg);
    await consumeAll();

    expect(await balanceOf(w.walletId)).toBe('75.00');
    const [inbox] = await sql`select consumer_name, processed_at is not null as done from inbox_messages where message_id = ${msg.messageId}`;
    expect(inbox).toEqual({ consumer_name: 'wager-transactions-consumer', done: true });
    const [tx] = await sql`select status from wager_transactions where external_transaction_id = ${msg.data.externalTransactionId as string}`;
    expect(tx.status).toBe('PROCESSED');
    expect(await drainQueue(sqs, WAGER_QUEUE, 1)).toHaveLength(0); // acked
  });

  it('redelivery of the same message never applies twice (inbox)', async () => {
    const w = await createWallet(app, '100.00');
    const msg = envelope(w, 'BET', '10');
    // Same envelope sent 3 times with different SQS dedup ids: the broker cannot help, the inbox must.
    for (let i = 0; i < 3; i++) await sendWagerMessage(sqs, msg);
    await consumeAll();

    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await sql`select 1 from wallet_ledger_entries where direction = 'DEBIT'`).toHaveLength(1);
    expect(await sql`select 1 from inbox_messages`).toHaveLength(1);
  });

  it('HTTP and SQS share idempotency: the same operation through both debits once', async () => {
    const w = await createWallet(app, '100.00');
    const msg = envelope(w, 'BET', '10');
    const { idempotencyKey, ...body } = msg.data;
    const http = await submit(app, body as unknown as Parameters<typeof submit>[1], idempotencyKey as string);
    expect(http.status).toBe(200);
    await sendWagerMessage(sqs, msg);
    await consumeAll();
    expect(await balanceOf(w.walletId)).toBe('90.00');
  });

  it('business rejections are final: acked, not retried, not dead-lettered', async () => {
    const w = await createWallet(app, '5.00');
    const insufficient = envelope(w, 'BET', '10');
    const unknownWallet = envelope({ ...w, walletId: uuidv7() }, 'BET', '1');
    await sendWagerMessage(sqs, insufficient);
    await sendWagerMessage(sqs, unknownWallet);
    await consumeAll();

    const [tx] = await sql`select status, failure_code from wager_transactions where kind = 'BET'`;
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await drainQueue(sqs, WAGER_DLQ, 1)).toHaveLength(0);
    expect(await drainQueue(sqs, WAGER_QUEUE, 1)).toHaveLength(0);
  });

  it('permanent failures go straight to the DLQ with the reason', async () => {
    const w = await createWallet(app, '100.00');
    const ok = envelope(w, 'BET', '10');
    await sendWagerMessage(sqs, ok);
    await consumeAll();

    await sendWagerMessage(sqs, '{not json', { groupId: 'poison' });
    await sendWagerMessage(sqs, envelope(w, 'OPENING', '10'), { groupId: 'g-opening' });
    await sendWagerMessage(sqs, { ...ok, messageId: `msg-${uuidv7()}`, data: { ...ok.data, money: brl('99.00') } }, { groupId: 'g-conflict' });
    await consumeAll();

    const dead = await drainQueue(sqs, WAGER_DLQ);
    const reasons = dead.map((m) => m.MessageAttributes?.reason?.StringValue).sort((a = '', b = '') => a.localeCompare(b));
    expect(reasons).toEqual(['INVALID_MESSAGE', 'INVALID_MESSAGE', 'PERMANENT_FAILURE']);
    expect(dead.find((m) => m.MessageAttributes?.reason?.StringValue === 'PERMANENT_FAILURE')?.MessageAttributes?.detail?.StringValue).toContain(
      'Idempotency',
    );
    expect(await balanceOf(w.walletId)).toBe('90.00');
  });

  it('transient failure (database unreachable): not acked, retried with backoff, then applied once', async () => {
    const w = await createWallet(app, '100.00');
    const msg = envelope(w, 'BET', '10');
    await sendWagerMessage(sqs, msg);

    // Real fault: the database refuses every connection of the app role.
    const superuser = new SQL({ url: 'postgres://postgres:postgres@localhost:55432/canopy_test', max: 1 });
    await superuser`alter role canopy_app connection limit 0`;
    await superuser`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'canopy_app'`;
    try {
      expect(await consumer.pollOnce()).toBe(1);
      // Still in the queue, invisible for the backoff (2 s on the 1st receive).
      expect(await consumer.pollOnce()).toBe(0);
    } finally {
      await superuser`alter role canopy_app connection limit -1`;
      await superuser.close();
    }

    await eventually(async () => (await consumer.pollOnce()) === 1, 15_000, 250);
    expect(await balanceOf(w.walletId)).toBe('90.00');
  });

  it('broker redrive: after 5 receives without ack the message lands in the DLQ', async () => {
    const wagerUrl = await queueUrl(sqs, WAGER_QUEUE);
    await sendWagerMessage(sqs, 'stuck', { groupId: 'g-stuck' });
    for (let i = 0; i < 5; i++) {
      const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: wagerUrl, WaitTimeSeconds: 1 }));
      const m = out.Messages?.[0];
      expect(m).toBeDefined();
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: wagerUrl, ReceiptHandle: m?.ReceiptHandle, VisibilityTimeout: 0 }));
    }
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: wagerUrl, WaitTimeSeconds: 1 })); // 6th receive triggers the move
    await eventually(async () => (await drainQueue(sqs, WAGER_DLQ, 1)).length === 1, 10_000);
  });

  it('worker killed after commit and before ack: the redelivery is detected and acked, no second debit', async () => {
    const w = await createWallet(app, '100.00');
    const msg = envelope(w, 'BET', '10');
    await sendWagerMessage(sqs, msg);

    // A separate process consumes, commits, then dies before DeleteMessage.
    const doomed = await spawnInstance({ roles: 'consumer', env: { CANOPY_CRASH_AFTER_COMMIT: '1' } });
    expect(await doomed.exited).toBe(137);
    expect(await balanceOf(w.walletId)).toBe('90.00');

    // The message comes back after the visibility timeout (5 s in tests).
    let duplicates = 0;
    WagerTransactionRequestedConsumer.hook = (e) => {
      if (e === 'duplicate') duplicates++;
    };
    try {
      await eventually(async () => (await consumer.pollOnce()) === 1, 20_000, 500);
    } finally {
      WagerTransactionRequestedConsumer.hook = undefined;
    }
    expect(duplicates).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await sql`select 1 from wallet_ledger_entries where direction = 'DEBIT'`).toHaveLength(1);
    expect(await drainQueue(sqs, WAGER_QUEUE, 1)).toHaveLength(0);
  });

  it('SIGTERM: a consumer process aborts its long poll and shuts down gracefully', async () => {
    const proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: `${__dirname}/../..`,
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', APP_ROLES: 'consumer', SQS_WAIT_TIME_SECONDS: '20' },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const logs = new Response(proc.stdout).text();
    await Bun.sleep(2500); // inside a 20 s long poll by now
    const started = Date.now();
    proc.kill('SIGTERM');
    const code = await proc.exited;

    expect(Date.now() - started).toBeLessThan(5000); // long poll aborted, not waited out
    // Nest runs the shutdown hooks, then re-raises the signal: 143 = 128 + SIGTERM.
    expect(code).toBe(143);
    expect(await logs).toContain('"msg":"worker stopped"');
  });
});
