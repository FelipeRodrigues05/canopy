import type { MoneyProps } from '../../../shared/domain/money';
import type { FailureCode } from '../domain/failure-code';
import type { WagerKind, WagerStatus } from '../domain/wager-kind';
import type { WagerTransaction } from '../domain/wager-transaction';

/** Current state of a transaction (unlike a replay, which returns the first answer). */
export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  status: WagerStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  referenceAttempts: number;
  nextRetryAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.amount.toProps(),
    status: tx.status,
    failureCode: tx.failureCode,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    referenceAttempts: tx.referenceAttempts,
    nextRetryAt: tx.nextRetryAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
