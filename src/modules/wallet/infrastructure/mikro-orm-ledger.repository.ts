import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { type LedgerPage, LedgerRepository } from '../application/ports/ledger.repository';
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
