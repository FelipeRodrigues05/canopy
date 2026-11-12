import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { PublishOutboxUseCase } from '../../src/modules/messaging/application/publish-outbox.use-case';
import { SqsQueues } from '../../src/shared/infrastructure/sqs/sqs-queues';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { drainQueue, testSqsClient } from '../support/sqs';
import { createWallet, submit, wager } from '../support/wagering';

const EVENTS_QUEUE = 'wallet-events.fifo';

describe('outbox publisher (real Postgres + LocalStack)', () => {
  const sql = openAdminSql();
  const sqs = testSqsClient();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(sql);
    await drainQueue(sqs, EVENTS_QUEUE, 1);
  });
  afterEach(() => assertLedgerInvariant(sql));
  afterAll(async () => {
    await app.close();
    await sql.close();
    sqs.destroy();
  });

  /** Outbox rows straight in SQL: many events quickly, without going through the API. */
  async function seedOutbox(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => uuidv7());
    const now = new Date(Date.now() - 1000);
    for (const id of ids) {
      const aggregateId = uuidv7();
      const payload = { eventId: id, eventType: 'TestEvent', aggregateId, correlationId: 'test', occurredAt: now.toISOString(), version: 1, data: {} };
      await sql`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
                values (${id}, ${aggregateId}, 'TestEvent', ${payload}, ${now}, 0, ${now})`;
    }
    return ids;
  }

  it('publishes committed events to the FIFO queue and marks them published', async () => {
    const w = await createWallet(app, '100.00');
    await submit(app, wager(w, 'BET', '10'));
    const pending = await sql`select id, aggregate_id, event_type from outbox_messages where published_at is null`;
    expect(pending).toHaveLength(4); // opening: processed + balance; bet: processed + balance

    const result = await app.get(PublishOutboxUseCase).publishPending();
    expect(result).toMatchObject({ claimed: 4, failed: 0 });
    expect(await sql`select 1 from outbox_messages where published_at is null`).toHaveLength(0);

    const received = await drainQueue(sqs, EVENTS_QUEUE);
    expect(received).toHaveLength(4);
    for (const message of received) {
      const body = JSON.parse(message.Body ?? '{}');
      const row = pending.find((p: { id: string }) => p.id === body.eventId);
      expect(row).toBeDefined();
      expect(message.Attributes?.MessageGroupId).toBe(row.aggregate_id);
      expect(message.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(row.event_type);
      expect(typeof body.data).toBe('object');
    }
  });

  it('crash after the business commit, before publishing: another instance publishes', async () => {
    // Instance A commits a business transaction and "dies" (no worker role, then closed).
    const instanceA = await createTestApp();
    const w = await createWallet(instanceA, '50.00');
    await instanceA.close();
    expect(await sql`select 1 from outbox_messages where published_at is null`).toHaveLength(2);

    // Instance B finds the committed events and publishes them.
    const instanceB = await createTestApp();
    try {
      await instanceB.get(PublishOutboxUseCase).publishPending();
    } finally {
      await instanceB.close();
    }
    const received = await drainQueue(sqs, EVENTS_QUEUE);
    expect(received.map((m) => JSON.parse(m.Body ?? '{}').data.walletId)).toEqual([w.walletId, w.walletId]);
  });

  it('two publishers (separate app instances and pools) share the outbox without double-claiming', async () => {
    const ids = await seedOutbox(300);
    const second = await createTestApp();
    try {
      const drain = async (instance: INestApplication) => {
        const mine: string[] = [];
        for (;;) {
          const r = await instance.get(PublishOutboxUseCase).publishPending(25);
          if (r.claimed === 0) return mine;
          mine.push(...r.published);
        }
      };
      const [a, b] = await Promise.all([drain(app), drain(second)]);

      // Every event published, by exactly one of the publishers.
      expect(a.length + b.length).toBe(300);
      expect(new Set([...a, ...b]).size).toBe(300);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      const [{ pending }] = await sql`select count(*)::int as pending from outbox_messages where published_at is null`;
      expect(pending).toBe(0);
      const received = await drainQueue(sqs, EVENTS_QUEUE);
      expect(new Set(received.map((m) => JSON.parse(m.Body ?? '{}').eventId))).toEqual(new Set(ids));
    } finally {
      await second.close();
    }
  });

  it('rows locked by an in-flight publisher are skipped, then picked up once released', async () => {
    const ids = await seedOutbox(6);
    const locked = ids.slice(0, 3);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let lockedReady!: () => void;
    const ready = new Promise<void>((r) => (lockedReady = r));

    // Simulates another publisher mid-batch: holds 3 rows FOR UPDATE, then rolls back (crash).
    const holder = sql
      .begin(async (tx) => {
        await tx`select id from outbox_messages where id in ${sql(locked)} for update`;
        lockedReady();
        await held;
        throw new Error('simulated crash');
      })
      .catch(() => undefined);
    await ready;

    const publisher = app.get(PublishOutboxUseCase);
    const first = await publisher.publishPending();
    expect(new Set(first.published)).toEqual(new Set(ids.slice(3)));

    release();
    await holder;
    const second = await publisher.publishPending();
    expect(new Set(second.published)).toEqual(new Set(locked));
  });

  it('broker failure: nothing is marked published, attempts grow and the retry is pushed out', async () => {
    const [id] = await seedOutbox(1);
    const broken = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SqsQueues)
      .useValue({ url: async () => 'http://localhost:54566/000000000000/does-not-exist.fifo' })
      .compile();
    const brokenApp = broken.createNestApplication({ logger: false });
    await brokenApp.init();
    try {
      const result = await brokenApp.get(PublishOutboxUseCase).publishPending();
      expect(result).toMatchObject({ claimed: 1, failed: 1, published: [] });
      const [row] = await sql`select attempts, published_at, last_error is not null as has_error,
                                     next_attempt_at > now() as postponed from outbox_messages where id = ${id}`;
      expect(row).toEqual({ attempts: 1, published_at: null, has_error: true, postponed: true });

      // Not due yet: a new cycle does not hammer the broker.
      expect((await brokenApp.get(PublishOutboxUseCase).publishPending()).claimed).toBe(0);
    } finally {
      await brokenApp.close();
    }

    // Once due again and the broker is fine, it goes out.
    await sql`update outbox_messages set next_attempt_at = now() where id = ${id}`;
    expect((await app.get(PublishOutboxUseCase).publishPending()).published).toEqual([id!]);
  });
});
