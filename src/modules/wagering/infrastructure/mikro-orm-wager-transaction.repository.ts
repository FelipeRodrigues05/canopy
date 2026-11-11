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

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WagerTransactionRecord)
      .insert(WagerTransactionMapper.toRecord(tx))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async update(tx: WagerTransaction): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      {
        status: r.status,
        failureCode: r.failureCode,
        referenceTransactionId: r.referenceTransactionId,
        outcome: r.outcome,
        referenceAttempts: r.referenceAttempts,
        nextRetryAt: r.nextRetryAt,
        processedAt: r.processedAt,
      },
    );
    if (affected !== 1) throw new Error(`Wager transaction ${tx.id} not found for update`);
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }, { disableIdentityMap: true });
    return r ? WagerTransactionMapper.toDomain(r) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return count > 0;
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
