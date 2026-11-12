import { ApplicationError } from '../../../shared/application/application-error';
import { DomainError } from '../../../shared/domain/domain-error';
import { isTransientDatabaseError } from '../../../shared/infrastructure/persistence/pg-errors';

/**
 * What the consumer does with a message whose processing threw (README 10):
 *
 * - business:  the outcome is final (e.g. WALLET_NOT_FOUND). Ack.
 * - permanent: the message can never succeed (malformed, idempotency
 *              conflict). Move to the DLQ now and ack; retrying is useless.
 * - transient: the world may be better later (database down, lock timeout).
 *              Do not ack; make it visible again after a backoff. After
 *              maxReceiveCount the broker's redrive policy moves it to the DLQ.
 *
 * Unknown errors are treated as transient: the redrive limit bounds them, and
 * guessing "permanent" could throw away a valid financial operation.
 */
export type FailureDisposition = 'business' | 'permanent' | 'transient';

export function classifyFailure(error: unknown): FailureDisposition {
  if (error instanceof ApplicationError) {
    switch (error.category) {
      case 'VALIDATION':
      case 'CONFLICT':
        return 'permanent';
      case 'BUSINESS':
      case 'NOT_FOUND':
        return 'business';
      case 'INFRA':
        return 'transient';
    }
  }
  if (isTransientDatabaseError(error)) return 'transient';
  if (error instanceof DomainError && error.code === 'INVALID_PAYLOAD') return 'permanent';
  return 'transient';
}

/** Visibility backoff for a transient failure: 2, 4, 8 ... seconds, capped at 5 minutes. */
export function retryDelaySeconds(receiveCount: number): number {
  return Math.min(2 ** Math.max(1, receiveCount), 300);
}
