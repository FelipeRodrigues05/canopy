import { SQL } from 'bun';
import { expect } from 'bun:test';
import { testEnv } from './env';

/**
 * Direct SQL access for assertions: tests check the database itself, never
 * through the ORM the code under test uses. Connects as the migrator role so
 * fixtures can TRUNCATE and tamper with data when a test needs to.
 */
export function openAdminSql(url = testEnv.migratorDatabaseUrl()): SQL {
  return new SQL({ url, max: 4 });
}

/** Same database, as the role the application uses (DML only). */
export function openAppSql(url = testEnv.appDatabaseUrl()): SQL {
  return new SQL({ url, max: 2 });
}

const TABLES = ['outbox_messages', 'inbox_messages', 'wallet_ledger_entries', 'wager_transactions', 'wallets'];

/** TRUNCATE does not fire row triggers, so the append-only ledger can be reset between tests. */
export async function resetDatabase(sql: SQL): Promise<void> {
  await sql.unsafe(`truncate ${TABLES.join(', ')} cascade`);
}

export interface LedgerDivergence {
  wallet_id: string;
  balance: string;
  version: string;
  ledger_balance: string;
  last_sequence: string | null;
  entries: string;
}

/**
 * README invariant, for every wallet: balance == balance rebuilt from the
 * ledger. Also checks the ledger is gap-free and numbered by the version.
 */
export async function findLedgerDivergences(sql: SQL): Promise<LedgerDivergence[]> {
  return sql<LedgerDivergence[]>`
    with ledger as (
      select wallet_id,
             coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0) as ledger_balance,
             max(sequence) as last_sequence,
             count(*) as entries,
             min(sequence) as first_sequence
        from wallet_ledger_entries group by wallet_id
    )
    select w.id as wallet_id, w.balance::text, w.version::text,
           coalesce(l.ledger_balance, 0)::text as ledger_balance,
           l.last_sequence::text, coalesce(l.entries, 0)::text as entries
      from wallets w left join ledger l on l.wallet_id = w.id
     where w.balance <> coalesce(l.ledger_balance, 0)
        or (l.last_sequence is not null and l.last_sequence <> w.version)
        or (l.last_sequence is null and w.version <> 1)
        or (l.entries is not null and l.last_sequence - l.first_sequence + 1 <> l.entries)`;
}

export async function assertLedgerInvariant(sql: SQL): Promise<void> {
  expect(await findLedgerDivergences(sql)).toEqual([]);
}
