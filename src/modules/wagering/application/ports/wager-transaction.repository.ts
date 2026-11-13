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
  /** Ids of PENDING_REFERENCE transactions due for another lookup, soonest first. No locks. */
  abstract findDuePendingIds(limit: number, now: Date): Promise<string[]>;
  /**
   * The transaction, locked FOR UPDATE SKIP LOCKED, only if it is still
   * PENDING_REFERENCE and due. Null when another worker holds it or it moved on.
   */
  abstract lockDuePending(id: string, now: Date): Promise<WagerTransaction | null>;
  /**
   * Makes transactions waiting for (providerId, externalTransactionId) due now,
   * so they do not sit out their backoff once the reference exists. Skips rows
   * a worker is holding. Returns how many were expedited.
   */
  abstract expediteWaitingFor(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  /** A PROCESSED REFUND or ROLLBACK already points at this transaction. */
  abstract hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}
