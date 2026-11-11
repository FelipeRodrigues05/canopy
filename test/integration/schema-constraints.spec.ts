import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import { v7 as uuidv7 } from 'uuid';
import { openAdminSql, openAppSql, resetDatabase } from '../support/db';

/**
 * The README requires uniqueness, immutability and non-negativity in the
 * schema itself. These tests talk to Postgres directly, bypassing the app, to
 * prove the database refuses bad data on its own.
 */
describe('schema constraints (database is the last line of defence)', () => {
  const admin = openAdminSql();
  const app = openAppSql();

  beforeEach(() => resetDatabase(admin));
  afterAll(async () => {
    await admin.close();
    await app.close();
  });

  /** A wallet with balance 100.00 at version 1 backed by its OPENING entry. */
  async function seedWallet(sql: SQL = app): Promise<{ walletId: string; openingId: string }> {
    const walletId = uuidv7();
    const openingId = uuidv7();
    const now = new Date();
    await sql.begin(async (tx) => {
      await tx`insert into wallets values (${walletId}, ${uuidv7()}, 'BRL', 100.00, 1, ${now}, ${now})`;
      await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                 round_id, game_id, kind, amount, currency, status, created_at, processed_at)
               values (${openingId}, 'canopy', ${'opening:' + walletId}, ${'opening:' + walletId}, ${'h'.repeat(64)}, ${walletId}, ${uuidv7()},
                 'opening', 'opening', 'OPENING', 100.00, 'BRL', 'PROCESSED', ${now}, ${now})`;
      await tx`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${openingId}, 1, 'CREDIT', 100.00, 'BRL', 0, 100.00, ${now})`;
    });
    return { walletId, openingId };
  }

  async function betTx(sql: SQL, walletId: string, overrides: { kind?: string; status?: string; ext?: string; key?: string; ref?: string | null } = {}) {
    const id = uuidv7();
    const now = new Date();
    const ext = overrides.ext ?? uuidv7();
    await sql`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                round_id, game_id, kind, amount, currency, status, failure_code, reference_external_transaction_id, reference_transaction_id, created_at, processed_at)
              values (${id}, 'provider-a', ${ext}, ${overrides.key ?? ext}, ${'h'.repeat(64)}, ${walletId}, ${uuidv7()}, 'r1', 'g1',
                ${overrides.kind ?? 'BET'}, 10.00, 'BRL', ${overrides.status ?? 'PROCESSED'}, null, ${overrides.ref ? 'ref-ext' : null}, ${overrides.ref ?? null}, ${now}, ${now})`;
    return id;
  }

  describe('ledger is append-only', () => {
    it('the app role cannot UPDATE, DELETE or TRUNCATE ledger entries (no privilege)', async () => {
      await seedWallet();
      expect(app`update wallet_ledger_entries set amount = 1`.then(() => 'ok')).rejects.toThrow(/permission denied/);
      expect(app`delete from wallet_ledger_entries`.then(() => 'ok')).rejects.toThrow(/permission denied/);
      expect(app`truncate wallet_ledger_entries`.then(() => 'ok')).rejects.toThrow(/permission denied/);
    });

    it('even the schema owner cannot UPDATE or DELETE them (trigger)', async () => {
      await seedWallet();
      expect(admin`update wallet_ledger_entries set created_at = now()`.then(() => 'ok')).rejects.toThrow(/append-only/);
      expect(admin`delete from wallet_ledger_entries`.then(() => 'ok')).rejects.toThrow(/append-only/);
    });
  });

  describe('balances never go negative', () => {
    it('wallet balance CHECK', async () => {
      const { walletId } = await seedWallet();
      expect(app`update wallets set balance = -1, version = 2 where id = ${walletId}`.then(() => 'ok')).rejects.toThrow(/check constraint/);
    });

    it('ledger amount and balances CHECK (with the match trigger out of the way)', async () => {
      const { walletId, openingId } = await seedWallet();
      const now = new Date();
      // The BEFORE INSERT trigger fires before CHECKs; disable it in this
      // transaction only (schema owner) to prove the CHECKs stand on their own.
      expect(
        admin.begin(async (tx) => {
          await tx`alter table wallet_ledger_entries disable trigger trg_ledger_matches_wallet`;
          await tx`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${openingId}, 2, 'DEBIT', 0, 'BRL', 100, 100, ${now})`;
        }).then(() => 'ok'),
      ).rejects.toThrow(/check constraint/);
      expect(
        admin.begin(async (tx) => {
          await tx`alter table wallet_ledger_entries disable trigger trg_ledger_matches_wallet`;
          await tx`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${openingId}, 2, 'DEBIT', 150, 'BRL', 100, -50, ${now})`;
        }).then(() => 'ok'),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('balance is always explained by the ledger', () => {
    it('changing a balance without a ledger entry is refused at commit', async () => {
      const { walletId } = await seedWallet();
      expect(
        app.begin((tx) => tx`update wallets set balance = 150.00, version = 2 where id = ${walletId}`).then(() => 'ok'),
      ).rejects.toThrow(/no ledger entry/);
      const [w] = await admin`select balance::text from wallets where id = ${walletId}`;
      expect(w.balance).toBe('100.00');
    });

    it('a ledger entry that does not describe the wallet row is refused', async () => {
      const { walletId } = await seedWallet();
      const txId = await betTx(app, walletId);
      const now = new Date();
      // wallet still at 100.00 / v1: an entry claiming v2 and 90.00 does not match it
      expect(
        app`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${txId}, 2, 'DEBIT', 10, 'BRL', 100, 90, ${now})`.then(() => 'ok'),
      ).rejects.toThrow(/does not match wallet/);
    });

    it('ledger arithmetic CHECK', async () => {
      const { walletId } = await seedWallet();
      const txId = await betTx(app, walletId);
      const now = new Date();
      expect(
        app.begin(async (tx) => {
          await tx`update wallets set balance = 91.00, version = 2 where id = ${walletId}`;
          await tx`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${txId}, 2, 'DEBIT', 10, 'BRL', 100, 91, ${now})`;
        }).then(() => 'ok'),
      ).rejects.toThrow(/ck_ledger_arithmetic/);
    });

    it('balance and version must move together, by one', async () => {
      const { walletId } = await seedWallet();
      expect(app`update wallets set version = 5 where id = ${walletId}`.then(() => 'ok')).rejects.toThrow(/together/);
      expect(app`update wallets set currency = 'USD' where id = ${walletId}`.then(() => 'ok')).rejects.toThrow(/immutable/);
    });

    it('a consistent debit commits', async () => {
      const { walletId } = await seedWallet();
      const txId = await betTx(app, walletId);
      const now = new Date();
      await app.begin(async (tx) => {
        await tx`update wallets set balance = 90.00, version = 2 where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${txId}, 2, 'DEBIT', 10, 'BRL', 100, 90, ${now})`;
      });
      const [w] = await admin`select balance::text, version::int from wallets where id = ${walletId}`;
      expect(w).toEqual({ balance: '90.00', version: 2 });
    });
  });

  describe('uniqueness', () => {
    it('one wallet per (player, currency)', async () => {
      const player = uuidv7();
      const now = new Date();
      await app`insert into wallets values (${uuidv7()}, ${player}, 'BRL', 0, 1, ${now}, ${now})`;
      expect(app`insert into wallets values (${uuidv7()}, ${player}, 'BRL', 0, 1, ${now}, ${now})`.then(() => 'ok')).rejects.toThrow(/ux_wallets_player_currency/);
    });

    it('idempotency key is unique per provider, not globally (A1)', async () => {
      const { walletId } = await seedWallet();
      await betTx(app, walletId, { key: 'same-key' });
      expect(betTx(app, walletId, { key: 'same-key' })).rejects.toThrow(/ux_wager_tx_idempotency/);
      // another provider may use the same key
      const id = uuidv7();
      const now = new Date();
      await app`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                  round_id, game_id, kind, amount, currency, status, created_at, processed_at)
                values (${id}, 'provider-b', 'x', 'same-key', ${'h'.repeat(64)}, ${walletId}, ${uuidv7()}, 'r', 'g', 'BET', 1, 'BRL', 'PROCESSED', ${now}, ${now})`;
    });

    it('external transaction id is unique per provider', async () => {
      const { walletId } = await seedWallet();
      await betTx(app, walletId, { ext: 'ext-1', key: 'k1' });
      expect(betTx(app, walletId, { ext: 'ext-1', key: 'k2' })).rejects.toThrow(/ux_wager_tx_external/);
    });

    it('a transaction is reversed at most once, whatever the reversal kind (A3)', async () => {
      const { walletId } = await seedWallet();
      const bet = await betTx(app, walletId);
      await betTx(app, walletId, { kind: 'REFUND', ref: bet });
      expect(betTx(app, walletId, { kind: 'ROLLBACK', ref: bet })).rejects.toThrow(/ux_wager_tx_reversal_once/);
      // a rejected attempt does not count
      await app`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                  round_id, game_id, kind, amount, currency, status, failure_code, reference_external_transaction_id, reference_transaction_id, created_at, processed_at)
                values (${uuidv7()}, 'provider-a', 'rej', 'rej', ${'h'.repeat(64)}, ${walletId}, ${uuidv7()}, 'r1', 'g1', 'ROLLBACK', 10, 'BRL',
                  'REJECTED', 'ALREADY_REVERSED', 'ref-ext', ${bet}, now(), now())`;
    });

    it('at most one ledger entry per (wallet, transaction)', async () => {
      const { walletId, openingId } = await seedWallet();
      const now = new Date();
      expect(
        app.begin(async (tx) => {
          await tx`update wallets set balance = 200.00, version = 2 where id = ${walletId}`;
          await tx`insert into wallet_ledger_entries values (${uuidv7()}, ${walletId}, ${openingId}, 2, 'CREDIT', 100, 'BRL', 100, 200, ${now})`;
        }).then(() => 'ok'),
      ).rejects.toThrow(/ux_ledger_wallet_transaction/);
    });

    it('inbox deduplicates by (consumer, message)', async () => {
      const now = new Date();
      await app`insert into inbox_messages values ('c1', 'm1', ${'h'.repeat(64)}, ${now}, null)`;
      expect(app`insert into inbox_messages values ('c1', 'm1', ${'h'.repeat(64)}, ${now}, null)`.then(() => 'ok')).rejects.toThrow(/duplicate key/);
      await app`insert into inbox_messages values ('c2', 'm1', ${'h'.repeat(64)}, ${now}, null)`;
    });
  });

  describe('transaction rules', () => {
    it('REFUND and ROLLBACK need a reference; OPENING only from canopy', async () => {
      const { walletId } = await seedWallet();
      const now = new Date();
      expect(
        app`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
              round_id, game_id, kind, amount, currency, status, created_at) values
              (${uuidv7()}, 'provider-a', 'x', 'x', ${'h'.repeat(64)}, ${walletId}, ${uuidv7()}, 'r', 'g', 'REFUND', 1, 'BRL', 'PENDING', ${now})`.then(() => 'ok'),
      ).rejects.toThrow(/ck_reversal_has_reference/);
      expect(
        app`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
              round_id, game_id, kind, amount, currency, status, created_at) values
              (${uuidv7()}, 'provider-a', 'y', 'y', ${'h'.repeat(64)}, ${walletId}, ${uuidv7()}, 'r', 'g', 'OPENING', 1, 'BRL', 'PENDING', ${now})`.then(() => 'ok'),
      ).rejects.toThrow(/ck_opening_is_internal/);
    });

    it('REJECTED needs a failure code', async () => {
      const { walletId } = await seedWallet();
      expect(betTx(app, walletId, { status: 'REJECTED' })).rejects.toThrow(/ck_rejected_has_failure_code/);
    });
  });
});
