import type { OutboxMessage } from '../../domain/outbox-message';

export abstract class OutboxRepository {
  /** Joins the current transaction: the events commit or roll back with the state change. */
  abstract add(messages: OutboxMessage[]): Promise<void>;

  /**
   * Due, unpublished messages, oldest first, locked FOR UPDATE SKIP LOCKED:
   * rows another publisher holds are skipped instead of waited for, so many
   * publishers share the table without blocking or double-claiming.
   * Needs a UnitOfWork; the locks last until it ends.
   */
  abstract claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
  abstract markPublished(ids: string[], at: Date): Promise<void>;
  abstract saveRetry(message: OutboxMessage): Promise<void>;

  /** Age in seconds of the oldest unpublished message (0 when there is none). */
  abstract oldestPendingAgeSeconds(now: Date): Promise<number>;
}
