import { defineEntity, type InferEntity, p } from '@mikro-orm/postgresql';
import type { IntegrationEventEnvelope } from '../../../shared/domain/integration-event';

export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<IntegrationEventEnvelope>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.text().nullable(),
  },
});
export type OutboxMessageRecord = InferEntity<typeof OutboxMessageRecord>;

export const InboxMessageRecord = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.string().length(64),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxMessageRecord = InferEntity<typeof InboxMessageRecord>;
