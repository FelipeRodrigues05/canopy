import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { assertLedgerInvariant, openAdminSql, resetDatabase } from '../support/db';
import { brl } from '../support/fixtures';
import { metricValue } from '../support/metrics';
import { createWallet, submit, wager } from '../support/wagering';

describe('queries and reconciliation (real Postgres)', () => {
  const sql = openAdminSql();
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(() => resetDatabase(sql));
  afterAll(async () => {
    await app.close();
    await sql.close();
  });

  describe('ledger pagination', () => {
    afterEach(() => assertLedgerInvariant(sql));

    it('newest first, opaque cursor, every entry exactly once across pages', async () => {
      const w = await createWallet(app, '100.00');
      for (let i = 0; i < 6; i++) await submit(app, wager(w, 'BET', '1'));
      await submit(app, wager(w, 'LOSS', '1')); // no entry

      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await http().get(`/wallets/${w.walletId}/ledger`).query({ limit: 3, ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        seen.push(...res.body.items.map((e: { sequence: number }) => e.sequence));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);

      expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
      expect(pages).toBe(3);
    });

    it('entries carry money as strings and stay stable while new entries arrive', async () => {
      const w = await createWallet(app, '50.00');
      await submit(app, wager(w, 'BET', '10'));
      const first = await http().get(`/wallets/${w.walletId}/ledger`).query({ limit: 1 });
      expect(first.body.items[0]).toMatchObject({ sequence: 2, direction: 'DEBIT', money: brl('10.00'), balanceBefore: brl('50.00'), balanceAfter: brl('40.00') });

      await submit(app, wager(w, 'WIN', '5')); // new entry on top while paginating
      const second = await http().get(`/wallets/${w.walletId}/ledger`).query({ limit: 1, cursor: first.body.nextCursor });
      expect(second.body.items.map((e: { sequence: number }) => e.sequence)).toEqual([1]);
      expect(second.body.nextCursor).toBeNull();
    });

    it('bad cursor or limit is 400; unknown wallet is 404', async () => {
      const w = await createWallet(app, '1.00');
      expect((await http().get(`/wallets/${w.walletId}/ledger`).query({ cursor: 'nope' })).status).toBe(400);
      expect((await http().get(`/wallets/${w.walletId}/ledger`).query({ limit: 201 })).status).toBe(400);
      expect((await http().get('/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger')).status).toBe(404);
    });
  });

  describe('transaction lookups', () => {
    afterEach(() => assertLedgerInvariant(sql));

    it('by internal id and by provider external id return the current state', async () => {
      const w = await createWallet(app, '100.00');
      const bet = wager(w, 'BET', '12.5');
      const res = await submit(app, bet);

      const byId = await http().get(`/wagering/transactions/${res.body.transactionId}`);
      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({
        transactionId: res.body.transactionId, kind: 'BET', status: 'PROCESSED', money: brl('12.50'), failureCode: null,
      });
      const byExternal = await http().get(`/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`);
      expect(byExternal.body).toEqual(byId.body);
    });

    it('GET shows the current state of a parked transaction, while a replay keeps the first answer', async () => {
      const w = await createWallet(app, '100.00');
      const res = await submit(app, wager(w, 'REFUND', '1', { referenceExternalTransactionId: 'not-yet' }));
      const current = await http().get(`/wagering/transactions/${res.body.transactionId}`);
      expect(current.body).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 0 });
      expect(current.body.nextRetryAt).toBeString();
    });

    it('404s', async () => {
      expect((await http().get('/wagering/transactions/0192f291-27dd-7d3f-8071-5f8685deef37')).body.error.code).toBe('TRANSACTION_NOT_FOUND');
      expect((await http().get('/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
      expect((await http().get('/wagering/transactions/not-a-uuid')).status).toBe(400);
    });
  });

  describe('reconciliation', () => {
    it('consistent wallet', async () => {
      const w = await createWallet(app, '100.00');
      await submit(app, wager(w, 'BET', '30'));
      await submit(app, wager(w, 'WIN', '12.34'));
      const res = await http().post(`/wallets/${w.walletId}/reconciliation`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        walletId: w.walletId,
        storedBalance: brl('82.34'),
        calculatedBalance: brl('82.34'),
        difference: brl('0.00'),
        consistent: true,
        checkedEntries: 3,
        walletVersion: 3,
        findings: [],
      });
      await assertLedgerInvariant(sql);
    });

    it('induced divergence is reported, counted and NOT corrected', async () => {
      const w = await createWallet(app, '100.00');
      await submit(app, wager(w, 'BET', '10'));

      // Tamper as the schema owner, with the guard triggers off for this one transaction.
      await sql.begin(async (tx) => {
        await tx`alter table wallets disable trigger trg_wallet_guard`;
        await tx`alter table wallets disable trigger trg_wallet_backed_by_ledger`;
        await tx`update wallets set balance = balance + 5 where id = ${w.walletId}`;
        await tx`alter table wallets enable trigger trg_wallet_guard`;
        await tx`alter table wallets enable trigger trg_wallet_backed_by_ledger`;
      });

      const mismatchesBefore = await metricValue(app, 'reconciliation_mismatches_total');
      const res = await http().post(`/wallets/${w.walletId}/reconciliation`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        storedBalance: brl('95.00'),
        calculatedBalance: brl('90.00'),
        difference: brl('5.00'),
        consistent: false,
        checkedEntries: 2,
      });
      expect(res.body.findings).toContain('stored balance differs from the ledger sum');
      expect(await metricValue(app, 'reconciliation_mismatches_total')).toBe(mismatchesBefore + 1);

      const [after] = await sql`select balance::text from wallets where id = ${w.walletId}`;
      expect(after.balance).toBe('95.00'); // untouched
    });

    it('unknown wallet is 404', async () => {
      expect((await http().post('/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation')).status).toBe(404);
    });
  });
});
