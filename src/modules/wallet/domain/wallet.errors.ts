import { DomainError } from '../../../shared/domain/domain-error';

/** BET larger than the balance. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/**
 * Reverting a credit (ROLLBACK of a WIN or REFUND) would take the balance below
 * zero. Distinct from INSUFFICIENT_FUNDS on purpose (README 7.9): the player
 * already spent the money, which is an operational situation, not a bad bet.
 */
export class ReversalWouldOverdrawError extends DomainError {
  readonly code = 'REVERSAL_WOULD_OVERDRAW';
}
