import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { type LedgerPage, LedgerRepository, type LedgerSummary } from '../application/ports/ledger.repository';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { LedgerEntryMapper } from './wallet.mapper';
import { LedgerEntryRecord } from './wallet.orm-entity';

@Injectable()
export class MikroOrmLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async summarize(walletId: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<
      { credits: string; debits: string; entries: number; last_sequence: number | null; last_balance_after: string | null }[]
    >(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::text  as debits,
              count(*)::int as entries,
              max(sequence)::int as last_sequence,
              (select balance_after::text from wallet_ledger_entries
                where wallet_id = ? order by sequence desc limit 1) as last_balance_after
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId, walletId],
    );
    return {
      credits: row?.credits ?? '0',
      debits: row?.debits ?? '0',
      entries: row?.entries ?? 0,
      lastSequence: row?.last_sequence ?? null,
      lastBalanceAfter: row?.last_balance_after ?? null,
    };
  }

  async page(walletId: string, options: { beforeSequence: number | null; limit: number }): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      options.beforeSequence === null ? { walletId } : { walletId, sequence: { $lt: options.beforeSequence } },
      { orderBy: { sequence: 'desc' }, limit: options.limit + 1, disableIdentityMap: true },
    );
    const items = records.slice(0, options.limit).map((r) => LedgerEntryMapper.toDomain(r));
    const last = items.at(-1);
    return { items, nextBeforeSequence: records.length > options.limit && last ? last.sequence : null };
  }
}
