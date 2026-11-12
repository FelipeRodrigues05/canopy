import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode, type QueryResult } from '@mikro-orm/postgresql';
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

  async findDuePendingIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: 'PENDING_REFERENCE', nextRetryAt: { $lte: now } },
      { fields: ['id'], orderBy: { nextRetryAt: 'asc' }, limit, disableIdentityMap: true },
    );
    return rows.map((r) => r.id);
  }

  async lockDuePending(id: string, now: Date): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(
      WagerTransactionRecord,
      { id, status: 'PENDING_REFERENCE', nextRetryAt: { $lte: now } },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, disableIdentityMap: true },
    );
    return r ? WagerTransactionMapper.toDomain(r) : null;
  }

  async expediteWaitingFor(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    const result = await this.em.execute<QueryResult>(
      `update wager_transactions set next_retry_at = ?
        where id in (select id from wager_transactions
                      where status = 'PENDING_REFERENCE' and provider_id = ? and reference_external_transaction_id = ?
                        and next_retry_at > ?
                      for update skip locked)`,
      [now, providerId, externalTransactionId, now],
      'run',
    );
    return result.affectedRows;
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
