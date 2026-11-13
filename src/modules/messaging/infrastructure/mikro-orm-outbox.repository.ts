import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../application/ports/outbox.repository';
import { OutboxMessage } from '../domain/outbox-message';
import { OutboxMessageRecord } from './messaging.orm-entity';

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: m.payload,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt,
        publishedAt: m.publishedAt,
        lastError: m.lastError,
      })),
    );
  }

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        // FOR UPDATE SKIP LOCKED
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return records.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregateId,
        eventType: r.eventType,
        payload: r.payload,
        occurredAt: r.occurredAt,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt,
        publishedAt: r.publishedAt ?? null,
        lastError: r.lastError ?? null,
      }),
    );
  }

  async markPublished(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: { $in: ids }, publishedAt: null },
      { publishedAt: at, lastError: null },
    );
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt, lastError: message.lastError },
    );
  }

  async oldestPendingAgeSeconds(now: Date): Promise<number> {
    const oldest = await this.em.findOne(
      OutboxMessageRecord,
      { publishedAt: null },
      { orderBy: { occurredAt: 'asc' }, fields: ['occurredAt'], disableIdentityMap: true },
    );
    return oldest ? Math.max(0, (now.getTime() - oldest.occurredAt.getTime()) / 1000) : 0;
  }
}
