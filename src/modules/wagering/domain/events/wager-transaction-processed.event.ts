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

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  processedAt: string;
}

/** Emitted for every PROCESSED transaction, LOSS included (RF04). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1 as const;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (tx.status !== 'PROCESSED' || !tx.processedAt) {
      throw new InvariantViolationError(
        `WagerTransactionProcessed for ${tx.status} transaction`,
      );
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      occurredAt: tx.processedAt,
      data: {
        ...wagerEventData(tx),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
