import { Migration } from '@mikro-orm/migrations';

/**
 * Core schema. Every guarantee the README asks to live in the database is here,
 * not only in application code (README 5.9):
 *
 * - uniqueness: one wallet per (player, currency); idempotency per
 *   (provider, key) (A1); one transaction per (provider, external id); at most
 *   one ledger entry per (wallet, transaction); one PROCESSED reversal per
 *   referenced transaction (A3); one inbox row per (consumer, message).
 * - non-negativity: CHECK on balances, amounts and ledger balances.
 * - immutability: ledger rejects UPDATE/DELETE by trigger and the app role
 *   has no UPDATE/DELETE/TRUNCATE on it.
 * - balance = ledger: an inserted entry must describe the wallet row as it is
 *   now, and a deferred trigger refuses to commit a wallet whose balance is not
 *   the balance_after of the entry numbered with its version.
 */
export class Migration20261111000100Schema extends Migration {
  override name = 'Migration20261111000100_schema';

  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) not null check (balance >= 0),
        version     bigint not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint ux_wallets_player_currency unique (player_id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null check (length(provider_id) between 1 and 100),
        external_transaction_id            text not null check (length(external_transaction_id) between 1 and 200),
        idempotency_key                    text not null check (length(idempotency_key) between 1 and 300),
        payload_hash                       char(64) not null,
        wallet_id                          uuid not null references wallets(id),
        player_id                          uuid not null,
        round_id                           text not null,
        game_id                            text not null,
        kind                               text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(20,2) not null check (amount >= 0),
        currency                           char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions(id),
        status                             text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       text,
        outcome                            jsonb,
        reference_attempts                 integer not null default 0 check (reference_attempts >= 0),
        next_retry_at                      timestamptz,
        created_at                         timestamptz not null,
        processed_at                       timestamptz,
        constraint ux_wager_tx_external unique (provider_id, external_transaction_id),
        constraint ux_wager_tx_idempotency unique (provider_id, idempotency_key),
        constraint ck_reversal_has_reference
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_rejected_has_failure_code
          check (status = 'FAILED' or (status = 'REJECTED') = (failure_code is not null)),
        constraint ck_pending_reference_is_scheduled
          check (status <> 'PENDING_REFERENCE' or next_retry_at is not null),
        constraint ck_terminal_has_processed_at
          check (status not in ('PROCESSED','REJECTED','FAILED') or processed_at is not null),
        constraint ck_opening_is_internal
          check ((kind = 'OPENING') = (provider_id = 'canopy' and external_transaction_id like 'opening:%'))
      )`);

    // A3: whatever its kind, a transaction is reversed at most once.
    this.addSql(`
      create unique index ux_wager_tx_reversal_once on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'`);
    this.addSql(`
      create index ix_wager_tx_pending_reference on wager_transactions (next_retry_at)
        where status = 'PENDING_REFERENCE'`);
    this.addSql(`
      create index ix_wager_tx_waiting_for on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'`);
    this.addSql(`create index ix_wager_tx_wallet on wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null references wallets(id),
        transaction_id  uuid not null references wager_transactions(id),
        sequence        bigint not null check (sequence >= 1),
        direction       text not null check (direction in ('DEBIT','CREDIT')),
        amount          numeric(20,2) not null check (amount > 0),
        currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_before  numeric(20,2) not null check (balance_before >= 0),
        balance_after   numeric(20,2) not null check (balance_after >= 0),
        created_at      timestamptz not null,
        constraint ux_ledger_wallet_transaction unique (wallet_id, transaction_id),
        constraint ux_ledger_wallet_sequence unique (wallet_id, sequence),
        constraint ck_ledger_arithmetic check (
          balance_after = case direction when 'CREDIT' then balance_before + amount else balance_before - amount end
        )
      )`);

    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     uuid not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz not null,
        published_at     timestamptz,
        last_error       text
      )`);
    this.addSql(`create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null`);

    // --- ledger is append-only -------------------------------------------------
    this.addSql(`
      create function canopy_forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end $$`);
    this.addSql(`
      create trigger trg_ledger_immutable before update or delete on wallet_ledger_entries
        for each row execute function canopy_forbid_ledger_mutation()`);
    this.addSql(`
      do $$ begin
        if exists (select 1 from pg_roles where rolname = 'canopy_app') then
          revoke update, delete, truncate on wallet_ledger_entries from canopy_app;
          revoke delete, truncate on wallets, wager_transactions from canopy_app;
        end if;
      end $$`);

    // --- a new entry must describe the wallet row as it is now -------------------
    // The use case updates the wallet (under FOR UPDATE) and then inserts the
    // entry, so the row already holds the new balance and version.
    this.addSql(`
      create function canopy_ledger_matches_wallet() returns trigger language plpgsql as $$
      declare w record;
      begin
        select balance, version, currency into w from wallets where id = new.wallet_id;
        if w.version is distinct from new.sequence
           or w.balance is distinct from new.balance_after
           or w.currency is distinct from new.currency then
          raise exception 'ledger entry (wallet %, sequence %, balance_after %) does not match wallet (version %, balance %)',
            new.wallet_id, new.sequence, new.balance_after, w.version, w.balance
            using errcode = 'check_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger trg_ledger_matches_wallet before insert on wallet_ledger_entries
        for each row execute function canopy_ledger_matches_wallet()`);

    // --- a wallet balance must be explained by the ledger at commit --------------
    this.addSql(`
      create function canopy_wallet_backed_by_ledger() returns trigger language plpgsql as $$
      declare entry_balance numeric(20,2);
      begin
        select balance_after into entry_balance
          from wallet_ledger_entries where wallet_id = new.id and sequence = new.version;
        if found then
          if entry_balance <> new.balance then
            raise exception 'wallet % balance % differs from ledger entry #% balance_after %',
              new.id, new.balance, new.version, entry_balance using errcode = 'check_violation';
          end if;
        elsif not (new.version = 1 and new.balance = 0) then
          raise exception 'wallet % at version % with balance % has no ledger entry #%',
            new.id, new.version, new.balance, new.version using errcode = 'check_violation';
        end if;
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger trg_wallet_backed_by_ledger after insert or update on wallets
        deferrable initially deferred
        for each row execute function canopy_wallet_backed_by_ledger()`);

    // --- wallet identity never changes and versions only move forward -----------
    this.addSql(`
      create function canopy_guard_wallet_update() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet % identity is immutable', old.id using errcode = 'restrict_violation';
        end if;
        -- version moves exactly when the balance moves, and by exactly one
        if (new.balance <> old.balance) <> (new.version = old.version + 1)
           or new.version not in (old.version, old.version + 1) then
          raise exception 'wallet % balance and version must change together by one step (v% -> v%)',
            old.id, old.version, new.version using errcode = 'check_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger trg_wallet_guard before update on wallets
        for each row execute function canopy_guard_wallet_update()`);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists canopy_guard_wallet_update()`);
    this.addSql(`drop function if exists canopy_wallet_backed_by_ledger()`);
    this.addSql(`drop function if exists canopy_ledger_matches_wallet()`);
    this.addSql(`drop function if exists canopy_forbid_ledger_mutation()`);
  }
}
