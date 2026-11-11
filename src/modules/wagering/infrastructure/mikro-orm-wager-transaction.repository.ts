import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionRepository } from '../application/ports/wager-transaction.repository';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.orm-entity';

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx));
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { disableIdentityMap: true });
    return r ? WagerTransactionMapper.toDomain(r) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { disableIdentityMap: true },
    );
    return r ? WagerTransactionMapper.toDomain(r) : null;
  }
}
