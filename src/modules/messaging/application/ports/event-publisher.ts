import type { OutboxMessage } from '../../domain/outbox-message';

export interface PublishReport {
  published: string[];
  failed: { id: string; error: string }[];
}

/** Sends outbox messages to the broker. Implementations never throw for per-message failures. */
export abstract class EventPublisher {
  abstract publish(messages: OutboxMessage[]): Promise<PublishReport>;
}
