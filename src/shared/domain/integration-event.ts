/** Ids every event needs from the operation that produced it. */
export interface EventContext {
  eventId: string;
  /** Request or message correlation id: ties the event to logs of its cause. */
  correlationId: string;
  /** Id of the message or command that directly caused this event, if any. */
  causationId?: string | undefined;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T extends object = object> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Event published to other systems through the outbox. Each concrete event
 * fixes `eventType` and `version` as literal types, so a consumer switching on
 * them gets the right `data` shape. `data` holds only plain JSON values: money
 * travels as `MoneyProps` (strings), never as a `Money` instance.
 */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /** Serialized envelope stored in the outbox payload. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
