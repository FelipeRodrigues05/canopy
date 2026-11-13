import type { Wallet } from '../../wallet/domain/wallet';
import { FailureCode } from './failure-code';
import type { WagerKind } from './wager-kind';
import type { WagerTransaction } from './wager-transaction';

/** How the wallet must move. `reverseCredit` is a debit that cannot overdraw. */
export type WalletOperation = 'debit' | 'credit' | 'reverseCredit';

export type WagerDecision =
  | { type: 'apply'; operation: WalletOperation; referenceTransactionId: string | null }
  | { type: 'noop'; referenceTransactionId: string | null }
  | { type: 'reject'; code: FailureCode; referenceTransactionId: string | null }
  | { type: 'awaitReference' };

export interface WagerPolicyInput {
  transaction: WagerTransaction;
  /** Locked wallet row (SELECT ... FOR UPDATE). */
  wallet: Wallet;
  /** Transaction found by (providerId, referenceExternalTransactionId), or null. */
  reference: WagerTransaction | null;
  /** True when the reference already has a PROCESSED REFUND or ROLLBACK (A3). */
  referenceAlreadyReversed: boolean;
}

/** Which kinds each kind may point at. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerKind, readonly WagerKind[]>> = {
  WIN: ['BET'],
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

const REVERSALS: readonly WagerKind[] = ['REFUND', 'ROLLBACK'];

/**
 * Pure decision of what a transaction does to a wallet. Holds every business
 * rule of the five kinds and of reference validation (RF02 to RF09); the use
 * case only executes the decision. Rules are checked in a fixed order, so the
 * same inputs always produce the same failure code.
 */
export const WagerPolicy = {
  decide(input: WagerPolicyInput): WagerDecision {
    const { transaction: tx, wallet } = input;

    if (wallet.playerId !== tx.playerId) return reject(FailureCode.WALLET_PLAYER_MISMATCH);
    if (!wallet.currency.equals(tx.amount.currency)) return reject(FailureCode.CURRENCY_MISMATCH);

    let referenceId: string | null = null;
    let referenceKind: WagerKind | null = null;

    if (tx.requiresReference) {
      const ref = input.reference;
      if (ref !== null && ref.id === tx.id) return reject(FailureCode.INVALID_REFERENCE_KIND);
      if (ref === null || ref.status === 'PENDING_REFERENCE' || ref.status === 'PENDING') {
        return { type: 'awaitReference' };
      }
      referenceId = ref.id;
      referenceKind = ref.kind;

      if (
        ref.providerId !== tx.providerId ||
        ref.playerId !== tx.playerId ||
        ref.walletId !== tx.walletId ||
        ref.roundId !== tx.roundId ||
        !ref.amount.currency.equals(tx.amount.currency)
      ) {
        return reject(FailureCode.REFERENCE_MISMATCH, referenceId);
      }
      if (!(ALLOWED_REFERENCE_KINDS[tx.kind] ?? []).includes(ref.kind)) {
        return reject(FailureCode.INVALID_REFERENCE_KIND, referenceId);
      }
      if (ref.status !== 'PROCESSED') return reject(FailureCode.REFERENCE_NOT_PROCESSED, referenceId);

      if (REVERSALS.includes(tx.kind)) {
        if (!ref.amount.equals(tx.amount)) return reject(FailureCode.AMOUNT_MISMATCH, referenceId);
        if (input.referenceAlreadyReversed) return reject(FailureCode.ALREADY_REVERSED, referenceId);
      }
    }

    const operation = operationFor(tx.kind, referenceKind);
    if (operation === null || tx.amount.isZero()) {
      return { type: 'noop', referenceTransactionId: referenceId };
    }
    if (operation === 'debit' && !wallet.canDebit(tx.amount)) {
      return reject(FailureCode.INSUFFICIENT_FUNDS, referenceId);
    }
    if (operation === 'reverseCredit' && !wallet.canDebit(tx.amount)) {
      return reject(FailureCode.REVERSAL_WOULD_OVERDRAW, referenceId);
    }
    return { type: 'apply', operation, referenceTransactionId: referenceId };
  },
};

function operationFor(kind: WagerKind, referenceKind: WagerKind | null): WalletOperation | null {
  switch (kind) {
    case 'OPENING':
    case 'WIN':
    case 'REFUND':
      return 'credit';
    case 'BET':
      return 'debit';
    case 'LOSS':
      return null;
    case 'ROLLBACK':
      // Undo of a debit gives the money back; undo of a credit takes it again.
      return referenceKind === 'BET' ? 'credit' : 'reverseCredit';
  }
}

function reject(code: FailureCode, referenceTransactionId: string | null = null): WagerDecision {
  return { type: 'reject', code, referenceTransactionId };
}
