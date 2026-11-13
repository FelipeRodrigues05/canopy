import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import {
  type EventContext,
  IntegrationEvent,
} from '../../../../shared/domain/integration-event';
import type { FailureCode } from '../failure-code';
import type { WagerTransaction } from '../wager-transaction';
import {
  type WagerTransactionEventData,
  wagerEventData,
} from './wager-transaction-event-data';

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1 as const;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (tx.status !== 'REJECTED' || !tx.failureCode || !tx.processedAt) {
      throw new InvariantViolationError(
        `WagerTransactionRejected for ${tx.status} transaction`,
      );
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      occurredAt: tx.processedAt,
      data: {
        ...wagerEventData(tx),
        failureCode: tx.failureCode,
        rejectedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
