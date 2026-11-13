import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { brl, newPlayerId } from '../support/fixtures';
import { type Instance, spawnInstance } from '../support/spawn';

/**
 * Real Keycloak (docker-compose.test.yaml, realm infra/keycloak/realm-wagering.json)
 * and a service process started with AUTH_ENABLED=true.
 */
const ISSUER = process.env.AUTH_TEST_ISSUER ?? 'http://localhost:58080/realms/wagering';

async function token(clientId: string, secret = `${clientId}-secret`): Promise<string> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`token for ${clientId}: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('authentication with Keycloak (real IdP, separate process)', () => {
  let api: Instance;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    api = await spawnInstance({ roles: 'api', env: { AUTH_ENABLED: 'true', AUTH_ISSUER: ISSUER } });
    for (const client of ['provider-a', 'provider-b', 'canopy-backoffice']) tokens[client] = await token(client);
  });
  afterAll(async () => {
    await api.stop();
  });

  const call = (method: string, path: string, opts: { as?: string; raw?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${api.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.as ? { authorization: `Bearer ${tokens[opts.as]}` } : {}),
        ...(opts.raw ? { authorization: opts.raw } : {}),
        ...opts.headers,
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });

  async function walletAs(client: string) {
    const playerId = newPlayerId();
    const res = await call('POST', '/wallets', { as: client, body: { playerId, initialBalance: brl('100.00') } });
    expect(res.status).toBe(201);
    return { walletId: ((await res.json()) as { id: string }).id, playerId };
  }

  const bet = (w: { walletId: string; playerId: string }, providerId: string) => ({
    providerId, externalTransactionId: `tx-${uuidv7()}`, playerId: w.playerId, walletId: w.walletId,
    roundId: 'r1', gameId: 'g1', kind: 'BET', money: brl('1.00'),
  });

  it('health and metrics stay open', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    expect((await call('GET', '/health/ready')).status).toBe(200);
    expect((await call('GET', '/metrics')).status).toBe(200);
  });

  it('no token, malformed or forged token -> 401 with the standard error body', async () => {
    const none = await call('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    expect((await call('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37', { raw: 'Bearer abc.def.ghi' })).status).toBe(401);
    expect((await call('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37', { raw: 'Basic cHJvdmlkZXItYTpzZWNyZXQ=' })).status).toBe(401);
    // a real token with its signature tampered
    const [h, p] = tokens['provider-a']!.split('.');
    expect((await call('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37', { raw: `Bearer ${h}.${p}.AAAA` })).status).toBe(401);
  });

  it('provider-a submits for provider-a (200) but not for provider-b (403)', async () => {
    const w = await walletAs('provider-a');
    const own = bet(w, 'provider-a');
    const ok = await call('POST', '/wagering/transactions', { as: 'provider-a', body: own, headers: { 'idempotency-key': own.externalTransactionId } });
    expect(ok.status).toBe(200);

    const spoofed = bet(w, 'provider-b');
    const res = await call('POST', '/wagering/transactions', { as: 'provider-a', body: spoofed, headers: { 'idempotency-key': spoofed.externalTransactionId } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('backoffice may create wallets, read and reconcile, but never submit as a provider', async () => {
    const w = await walletAs('canopy-backoffice');
    expect((await call('POST', `/wallets/${w.walletId}/reconciliation`, { as: 'canopy-backoffice' })).status).toBe(200);
    const b = bet(w, 'provider-a');
    expect(
      (await call('POST', '/wagering/transactions', { as: 'canopy-backoffice', body: b, headers: { 'idempotency-key': 'x' } })).status,
    ).toBe(403);
  });

  it("a provider cannot see another provider's transactions", async () => {
    const w = await walletAs('provider-a');
    const b = bet(w, 'provider-a');
    const created = (await (await call('POST', '/wagering/transactions', { as: 'provider-a', body: b, headers: { 'idempotency-key': b.externalTransactionId } })).json()) as { transactionId: string };

    expect((await call('GET', `/wagering/transactions/${created.transactionId}`, { as: 'provider-a' })).status).toBe(200);
    expect((await call('GET', `/wagering/transactions/${created.transactionId}`, { as: 'provider-b' })).status).toBe(404);
    expect((await call('GET', `/providers/provider-a/wagering/transactions/${b.externalTransactionId}`, { as: 'provider-b' })).status).toBe(403);
    expect((await call('GET', `/providers/provider-a/wagering/transactions/${b.externalTransactionId}`, { as: 'canopy-backoffice' })).status).toBe(200);
  });
});
