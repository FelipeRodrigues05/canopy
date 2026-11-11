import type { OutboxMessage } from '../../domain/outbox-message';

export abstract class OutboxRepository {
  /** Joins the current transaction: the events commit or roll back with the state change. */
  abstract add(messages: OutboxMessage[]): Promise<void>;
}
