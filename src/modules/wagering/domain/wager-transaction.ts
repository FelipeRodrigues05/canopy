import { InvalidValueError, InvariantViolationError } from '../../../shared/domain/domain-error';
import type { Money, MoneyProps } from '../../../shared/domain/money';
import type { FailureCode } from './failure-code';
import {
  KINDS_REQUIRING_REFERENCE,
  TERMINAL_STATUSES,
  isSubmittableKind,
  type WagerKind,
  type WagerStatus,
} from './wager-kind';

/**
 * What the caller was told the first time (README 7.7, A5). Stored once and
 * replayed verbatim on every duplicate, including the balance seen then, so a
 * replay never recomputes anything.
 */
export interface WagerOutcomeSnapshot {
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  failureCode: FailureCode | null;
  balance: MoneyProps;
  walletVersion: number;
  decidedAt: string;
}

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  amount: Money;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerStatus;
  failureCode: FailureCode | null;
  outcome: WagerOutcomeSnapshot | null;
  referenceAttempts: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface SubmitWagerInput {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: Money;
  referenceExternalTransactionId: string | null;
  now: Date;
}

export const OPENING_PROVIDER_ID = 'canopy';

/**
 * State machine:
 *
 *   PENDING ──> PROCESSED | REJECTED | FAILED
 *      └──> PENDING_REFERENCE ──> PROCESSED | REJECTED | FAILED
 *                 └──(attempt)──> PENDING_REFERENCE
 *
 * PROCESSED, REJECTED and FAILED are terminal: any transition out of them is a
 * bug and throws.
 */
export class WagerTransaction {
  private constructor(private props: WagerTransactionProps) {}

  /** Operation sent by a provider (HTTP or SQS). */
  static submit(input: SubmitWagerInput): WagerTransaction {
    if (!isSubmittableKind(input.kind)) {
      throw new InvalidValueError(`Kind ${JSON.stringify(input.kind)} cannot be submitted`);
    }
    const reference = input.referenceExternalTransactionId;
    if (KINDS_REQUIRING_REFERENCE.includes(input.kind) && !reference) {
      throw new InvalidValueError(`${input.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== null && reference === input.externalTransactionId) {
      throw new InvalidValueError('A transaction cannot reference itself');
    }
    return new WagerTransaction(WagerTransaction.pending({ ...input, kind: input.kind }));
  }

  /** Internal credit that funds a new wallet (RF01). */
  static opening(input: {
    id: string;
    walletId: string;
    playerId: string;
    amount: Money;
    payloadHash: string;
    now: Date;
  }): WagerTransaction {
    const key = `opening:${input.walletId}`;
    return new WagerTransaction(
      WagerTransaction.pending({
        ...input,
        providerId: OPENING_PROVIDER_ID,
        externalTransactionId: key,
        idempotencyKey: key,
        roundId: 'opening',
        gameId: 'opening',
        kind: 'OPENING',
        referenceExternalTransactionId: null,
      }),
    );
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction({ ...props });
  }

  private static pending(
    input: Omit<SubmitWagerInput, 'kind'> & { kind: WagerKind },
  ): WagerTransactionProps {
    return {
      id: input.id,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      amount: input.amount,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      referenceTransactionId: null,
      status: 'PENDING',
      failureCode: null,
      outcome: null,
      referenceAttempts: 0,
      nextRetryAt: null,
      createdAt: input.now,
      processedAt: null,
    };
  }

  get requiresReference(): boolean {
    return this.props.referenceExternalTransactionId !== null;
  }

  /** Same idempotency key + same hash = replay; same key + other hash = conflict. */
  matchesPayload(payloadHash: string): boolean {
    return this.props.payloadHash === payloadHash;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.props.status);
  }

  markProcessed(now: Date, referenceTransactionId: string | null = null): void {
    this.assertOpen('markProcessed');
    this.props = {
      ...this.props,
      status: 'PROCESSED',
      failureCode: null,
      referenceTransactionId: referenceTransactionId ?? this.props.referenceTransactionId,
      nextRetryAt: null,
      processedAt: now,
    };
  }

  reject(code: FailureCode, now: Date, referenceTransactionId: string | null = null): void {
    this.assertOpen('reject');
    this.props = {
      ...this.props,
      status: 'REJECTED',
      failureCode: code,
      referenceTransactionId: referenceTransactionId ?? this.props.referenceTransactionId,
      nextRetryAt: null,
      processedAt: now,
    };
  }

  /** Infrastructure gave up permanently. Kept for audit; no money moved. */
  fail(now: Date): void {
    this.assertOpen('fail');
    this.props = { ...this.props, status: 'FAILED', failureCode: 'INFRA_PERMANENT_FAILURE', nextRetryAt: null, processedAt: now };
  }

  /** First time the reference is missing: park it for the pending-reference worker. */
  awaitReference(nextRetryAt: Date): void {
    if (this.props.status !== 'PENDING') {
      throw new InvariantViolationError(`awaitReference from ${this.props.status}`);
    }
    if (!this.requiresReference) {
      throw new InvariantViolationError('awaitReference on a transaction without reference');
    }
    this.props = { ...this.props, status: 'PENDING_REFERENCE', nextRetryAt };
  }

  /** The worker looked again and the reference is still missing. */
  registerReferenceAttempt(nextRetryAt: Date): void {
    if (this.props.status !== 'PENDING_REFERENCE') {
      throw new InvariantViolationError(`registerReferenceAttempt from ${this.props.status}`);
    }
    this.props = { ...this.props, referenceAttempts: this.props.referenceAttempts + 1, nextRetryAt };
  }

  /** Stores the first answer given to the caller. Later outcomes never overwrite it. */
  recordOutcome(outcome: WagerOutcomeSnapshot): void {
    if (this.props.outcome === null) {
      this.props = { ...this.props, outcome };
    }
  }

  private assertOpen(action: string): void {
    if (this.isTerminal) {
      throw new InvariantViolationError(`${action} on terminal transaction ${this.props.id} (${this.props.status})`);
    }
  }

  get id(): string {
    return this.props.id;
  }
  get providerId(): string {
    return this.props.providerId;
  }
  get externalTransactionId(): string {
    return this.props.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get walletId(): string {
    return this.props.walletId;
  }
  get playerId(): string {
    return this.props.playerId;
  }
  get roundId(): string {
    return this.props.roundId;
  }
  get gameId(): string {
    return this.props.gameId;
  }
  get kind(): WagerKind {
    return this.props.kind;
  }
  get amount(): Money {
    return this.props.amount;
  }
  get referenceExternalTransactionId(): string | null {
    return this.props.referenceExternalTransactionId;
  }
  get referenceTransactionId(): string | null {
    return this.props.referenceTransactionId;
  }
  get status(): WagerStatus {
    return this.props.status;
  }
  get failureCode(): FailureCode | null {
    return this.props.failureCode;
  }
  get outcome(): WagerOutcomeSnapshot | null {
    return this.props.outcome;
  }
  get referenceAttempts(): number {
    return this.props.referenceAttempts;
  }
  get nextRetryAt(): Date | null {
    return this.props.nextRetryAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get processedAt(): Date | null {
    return this.props.processedAt;
  }

  toProps(): Readonly<WagerTransactionProps> {
    return { ...this.props };
  }
}
