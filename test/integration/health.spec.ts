import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';

describe('health (real Postgres + LocalStack)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live answers 200 without touching dependencies', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready checks Postgres and SQS', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(res.body.info.sqs.status).toBe('up');
  });

  it('echoes the correlation id header', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').set('x-correlation-id', 'corr-123');
    expect(res.headers['x-correlation-id']).toBe('corr-123');
  });
});
