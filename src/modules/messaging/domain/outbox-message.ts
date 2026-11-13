import { InvariantViolationError } from '../../../shared/domain/domain-error';
import type { IntegrationEvent, IntegrationEventEnvelope } from '../../../shared/domain/integration-event';

export interface OutboxMessageProps {
  /** Equals the event id, so consumers can deduplicate by it. */
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
}

export const OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Event waiting to be published. Inserted in the same SQL transaction as the
 * state change that produced it; only the publisher worker sends it, after
 * that transaction committed. Delivery is at-least-once.
 */
export class OutboxMessage {
  private constructor(private props: OutboxMessageProps) {}

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
      lastError: null,
    });
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage({ ...props });
  }

  /** Exponential backoff: 1s, 2s, 4s, ... capped at 5 minutes. */
  static backoffMs(attempts: number): number {
    return Math.min(1000 * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_BACKOFF_MS);
  }

  isPending(): boolean {
    return this.props.publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.props.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(now: Date): void {
    if (this.props.publishedAt !== null) {
      throw new InvariantViolationError(`Outbox message ${this.props.id} already published`);
    }
    this.props = { ...this.props, publishedAt: now, lastError: null };
  }

  /** Publishing failed: count the attempt and push the next one out (backoff). */
  scheduleRetry(now: Date, error: string): void {
    const attempts = this.props.attempts + 1;
    this.props = {
      ...this.props,
      attempts,
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(now.getTime() + OutboxMessage.backoffMs(attempts)),
    };
  }

  get id(): string {
    return this.props.id;
  }
  get aggregateId(): string {
    return this.props.aggregateId;
  }
  get eventType(): string {
    return this.props.eventType;
  }
  get payload(): IntegrationEventEnvelope {
    return this.props.payload;
  }
  get occurredAt(): Date {
    return this.props.occurredAt;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get nextAttemptAt(): Date {
    return this.props.nextAttemptAt;
  }
  get publishedAt(): Date | null {
    return this.props.publishedAt;
  }
  get lastError(): string | null {
    return this.props.lastError;
  }
}
