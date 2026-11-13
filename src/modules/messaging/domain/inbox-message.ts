import { InvariantViolationError } from '../../../shared/domain/domain-error';

export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

/**
 * Record that a consumer has seen a broker message. Keyed by
 * (consumerName, messageId) and written in the same SQL transaction as the
 * effect of the message, so a redelivery after commit is detected and acked
 * without doing anything twice.
 */
export class InboxMessage {
  private constructor(private props: InboxMessageProps) {}

  static receive(input: { consumerName: string; messageId: string; payloadHash: string; now: Date }): InboxMessage {
    if (!input.consumerName || !input.messageId) {
      throw new InvariantViolationError('Inbox message needs consumerName and messageId');
    }
    return new InboxMessage({ ...input, receivedAt: input.now, processedAt: null });
  }

  static rehydrate(props: InboxMessageProps): InboxMessage {
    return new InboxMessage({ ...props });
  }

  markProcessed(now: Date): void {
    if (this.props.processedAt !== null) {
      throw new InvariantViolationError(`Inbox message ${this.props.messageId} already processed`);
    }
    this.props = { ...this.props, processedAt: now };
  }

  get isProcessed(): boolean {
    return this.props.processedAt !== null;
  }
  get consumerName(): string {
    return this.props.consumerName;
  }
  get messageId(): string {
    return this.props.messageId;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get receivedAt(): Date {
    return this.props.receivedAt;
  }
  get processedAt(): Date | null {
    return this.props.processedAt;
  }
}
