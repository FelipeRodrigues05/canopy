import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import {
  type EventContext,
  IntegrationEvent,
} from '../../../../shared/domain/integration-event';
import type { WagerTransaction } from '../wager-transaction';
import {
  type WagerTransactionEventData,
  wagerEventData,
} from './wager-transaction-event-data';

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  nextRetryAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1 as const;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
    now: Date,
  ): WagerTransactionPendingReference {
    if (tx.status !== 'PENDING_REFERENCE' || !tx.nextRetryAt) {
      throw new InvariantViolationError(
        `WagerTransactionPendingReference for ${tx.status} transaction`,
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      occurredAt: now,
      data: {
        ...wagerEventData(tx),
        nextRetryAt: tx.nextRetryAt.toISOString(),
      },
    });
  }
}
