import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { openAdminSql, resetDatabase } from '../support/db';
import { metricValue } from '../support/metrics';
import { createWallet, submit, wager } from '../support/wagering';

describe('GET /metrics', () => {
  const sql = openAdminSql();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(() => resetDatabase(sql));
  afterAll(async () => {
    await app.close();
    await sql.close();
  });

  it('exposes the minimum metrics of README 12 in Prometheus format', async () => {
    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'wager_transactions_total',
      'idempotent_duplicates_total',
      'processing_retries_total',
      'dlq_messages_total',
      'lock_conflicts_total',
      'outbox_lag_seconds',
      'wager_processing_duration_seconds',
      'reconciliation_mismatches_total',
    ]) {
      expect(res.text).toContain(`# TYPE ${name}`);
    }
  });

  it('counts decisions by status/kind/source, replays as duplicates, and times every submission', async () => {
    const w = await createWallet(app, '10.00');
    const processed = () => metricValue(app, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET', source: 'http' });
    const rejected = () => metricValue(app, 'wager_transactions_total', { status: 'REJECTED', kind: 'BET', source: 'http' });
    const dupes = () => metricValue(app, 'idempotent_duplicates_total', { source: 'http' });
    const [p0, r0, d0] = [await processed(), await rejected(), await dupes()];

    const bet = wager(w, 'BET', '4');
    await submit(app, bet);
    await submit(app, bet); // replay
    await submit(app, wager(w, 'BET', '50')); // insufficient

    expect(await processed()).toBe(p0 + 1);
    expect(await rejected()).toBe(r0 + 1);
    expect(await dupes()).toBe(d0 + 1);
    const text = (await request(app.getHttpServer()).get('/metrics')).text;
    expect(text).toMatch(/wager_processing_duration_seconds_count\{source="http",kind="BET",outcome="REPLAY"\} \d+/);
  });

  it('outbox_lag_seconds reflects the oldest unpublished event', async () => {
    await createWallet(app, '1.00');
    await sql`update outbox_messages set occurred_at = now() - interval '42 seconds'`;
    expect(await metricValue(app, 'outbox_lag_seconds')).toBeGreaterThanOrEqual(42);
    await sql`update outbox_messages set published_at = now()`;
    expect(await metricValue(app, 'outbox_lag_seconds')).toBe(0);
  });
});
