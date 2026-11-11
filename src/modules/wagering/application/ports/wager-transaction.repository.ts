import type { WagerTransaction } from '../../domain/wager-transaction';

export abstract class WagerTransactionRepository {
  abstract insert(tx: WagerTransaction): Promise<void>;
  /** INSERT ... ON CONFLICT DO NOTHING. False when a unique key (idempotency, external id, reversal) already exists. */
  abstract insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  /** Writes the mutable part of the row (status, outcome, retry schedule). */
  abstract update(tx: WagerTransaction): Promise<void>;
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  /** A PROCESSED REFUND or ROLLBACK already points at this transaction. */
  abstract hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}
