import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../application/ports/outbox.repository';
import type { OutboxMessage } from '../domain/outbox-message';
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
}
