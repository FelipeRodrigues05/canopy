import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { Money } from '../../../shared/domain/money';
import { isFailureCode } from '../domain/failure-code';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionRecord } from './wager-transaction.orm-entity';

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    if (r.failureCode !== null && r.failureCode !== undefined && !isFailureCode(r.failureCode)) {
      throw new InvariantViolationError(`Unknown failure code in database: ${r.failureCode}`);
    }
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind,
      amount: Money.from(r.amount, r.currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? null,
      referenceTransactionId: r.referenceTransactionId ?? null,
      status: r.status,
      failureCode: r.failureCode && isFailureCode(r.failureCode) ? r.failureCode : null,
      outcome: r.outcome ?? null,
      referenceAttempts: r.referenceAttempts,
      nextRetryAt: r.nextRetryAt ?? null,
      createdAt: r.createdAt,
      processedAt: r.processedAt ?? null,
    });
  },

  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    const p = tx.toProps();
    return {
      id: p.id,
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: p.idempotencyKey,
      payloadHash: p.payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind: p.kind,
      amount: p.amount.toString(),
      currency: p.amount.currency.code,
      referenceExternalTransactionId: p.referenceExternalTransactionId,
      referenceTransactionId: p.referenceTransactionId,
      status: p.status,
      failureCode: p.failureCode,
      outcome: p.outcome,
      referenceAttempts: p.referenceAttempts,
      nextRetryAt: p.nextRetryAt,
      createdAt: p.createdAt,
      processedAt: p.processedAt,
    };
  },
};
