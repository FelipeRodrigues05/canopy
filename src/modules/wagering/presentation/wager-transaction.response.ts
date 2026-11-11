import { HttpStatus } from '@nestjs/common';
import type { MoneyProps } from '../../../shared/domain/money';
import type { SubmitWagerResult } from '../application/submit-wager-transaction.use-case';
import type { FailureCode } from '../domain/failure-code';

export interface SubmitWagerResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  failureCode?: FailureCode;
  balance: MoneyProps;
  walletVersion: number;
  idempotentReplay: boolean;
}

/**
 * Status follows the first recorded outcome, so a replay answers exactly like
 * the original request did:
 *   PROCESSED -> 200, PENDING_REFERENCE -> 202 (accepted, will be resolved), REJECTED -> 422.
 */
export function toSubmitResponse(result: SubmitWagerResult): { status: number; body: SubmitWagerResponse } {
  const { outcome } = result;
  const status =
    outcome.status === 'PROCESSED'
      ? HttpStatus.OK
      : outcome.status === 'PENDING_REFERENCE'
        ? HttpStatus.ACCEPTED
        : HttpStatus.UNPROCESSABLE_ENTITY;
  return {
    status,
    body: {
      transactionId: result.transactionId,
      status: outcome.status,
      ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      balance: outcome.balance,
      walletVersion: outcome.walletVersion,
      idempotentReplay: result.idempotentReplay,
    },
  };
}
