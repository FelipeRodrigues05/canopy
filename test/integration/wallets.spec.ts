import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl, newPlayerId } from '../support/fixtures';

describe('wallets (real Postgres)', () => {
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

  const http = () => request(app.getHttpServer());

  it('creates a funded wallet: OPENING + CREDIT entry + events in one transaction', async () => {
    const playerId = newPlayerId();
    const res = await http().post('/wallets').send({ playerId, initialBalance: brl('1000') });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: brl('1000.00'), version: 1 });
    const walletId: string = res.body.id;

    const [opening] = await sql`select kind, status, amount::text, provider_id from wager_transactions where wallet_id = ${walletId}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00', provider_id: 'canopy' });

    const entries = await sql`select sequence::int, direction, amount::text, balance_before::text, balance_after::text
                                from wallet_ledger_entries where wallet_id = ${walletId}`;
    expect(entries).toEqual([{ sequence: 1, direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00' }]);

    const events = await sql`select event_type, payload from outbox_messages order by event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const changed = events.find((e: { event_type: string }) => e.event_type === 'WalletBalanceChanged');
    expect(changed.payload.data).toMatchObject({ walletId, money: brl('1000.00'), balanceAfter: brl('1000.00'), walletVersion: 1 });
    expect(changed.payload.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('a zero initial balance opens at version 1 with no ledger entry and no event', async () => {
    const res = await http().post('/wallets').send({ playerId: newPlayerId(), initialBalance: brl('0.00') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: brl('0.00'), version: 1 });
    const [{ n }] = await sql`select (select count(*) from wallet_ledger_entries) + (select count(*) from outbox_messages) + (select count(*) from wager_transactions) as n`;
    expect(Number(n)).toBe(0);
  });

  it('one wallet per player and currency: duplicate is 409, another currency is fine', async () => {
    const playerId = newPlayerId();
    expect((await http().post('/wallets').send({ playerId, initialBalance: brl('10') })).status).toBe(201);
    const dup = await http().post('/wallets').send({ playerId, initialBalance: brl('99') });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', category: 'CONFLICT', retryable: false });
    expect((await http().post('/wallets').send({ playerId, initialBalance: { amount: '5', currency: 'USD' } })).status).toBe(201);

    const [{ n }] = await sql`select count(*)::int as n from wager_transactions`;
    expect(n).toBe(2); // the failed duplicate left nothing behind
  });

  it('concurrent duplicate creation: exactly one wins', async () => {
    const playerId = newPlayerId();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => http().post('/wallets').send({ playerId, initialBalance: brl('50') })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const [{ n }] = await sql`select count(*)::int as n from wallet_ledger_entries`;
    expect(n).toBe(1);
  });

  it.each([
    ['negative', { playerId: newPlayerId(), initialBalance: brl('-1.00') }],
    ['3 decimals', { playerId: newPlayerId(), initialBalance: brl('1.001') }],
    ['number amount', { playerId: newPlayerId(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['scientific', { playerId: newPlayerId(), initialBalance: brl('1e3') }],
    ['bad currency', { playerId: newPlayerId(), initialBalance: { amount: '1', currency: 'brl' } }],
    ['not a uuid', { playerId: 'player-1', initialBalance: brl('1') }],
    ['unknown field', { playerId: newPlayerId(), initialBalance: brl('1'), extra: true }],
  ])('rejects invalid payload (%s) with 400', async (_label, body) => {
    const res = await http().post('/wallets').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_PAYLOAD', category: 'VALIDATION', retryable: false });
  });

  it('GET returns balance and version; unknown id is 404', async () => {
    const created = await http().post('/wallets').send({ playerId: newPlayerId(), initialBalance: brl('12.5') });
    const res = await http().get(`/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, balance: brl('12.50'), version: 1 });

    const missing = await http().get('/wallets/0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});
