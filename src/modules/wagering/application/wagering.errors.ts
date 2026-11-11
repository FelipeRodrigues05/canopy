import { ApplicationError } from '../../../shared/application/application-error';

/** Same idempotency key (or external id) with a different payload: a conflict, never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly category = 'CONFLICT' as const;
}

/**
 * The wallet in the payload does not exist. Answered as a business rejection
 * (422) without persisting the transaction (A2): the row would need a wallet
 * to reference, and the answer is stable because a wallet id never comes into
 * existence later.
 */
export class UnknownWalletError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly category = 'BUSINESS' as const;
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly category = 'NOT_FOUND' as const;
}

/**
 * Another transaction inserted the same unique key between our check and our
 * insert. Internal only: the use case runs again and resolves it as a replay
 * or a conflict.
 */
export class ConcurrentSubmissionError extends Error {}
