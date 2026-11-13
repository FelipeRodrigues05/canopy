import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { IdGenerator } from '../../../shared/application/id-generator';
import { AppMetrics, type SubmissionOutcome } from '../../../shared/application/metrics';
import { ApplicationError } from '../../../shared/application/application-error';
import { InvalidPayloadError } from '../../../shared/application/application-error';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { InvalidValueError } from '../../../shared/domain/domain-error';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { InboxRepository } from '../../messaging/application/ports/inbox.repository';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { WalletRepository } from '../../wallet/application/ports/wallet.repository';
import { type WagerOutcomeSnapshot, WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { wagerFingerprint } from './wager-fingerprint';
import { WagerProcessor } from './wager-processor';
import { ConcurrentSubmissionError, IdempotencyConflictError, UnknownWalletError } from './wagering.errors';

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null | undefined;
  correlationId: string;
}

/** Where the command came from. SQS deliveries are deduplicated through the inbox. */
export type SubmissionSource =
  | { type: 'HTTP' }
  | { type: 'SQS'; consumerName: string; messageId: string; messageHash: string };

export interface SubmitWagerResult {
  transactionId: string;
  /** What was answered the first time; a replay returns it unchanged. */
  outcome: WagerOutcomeSnapshot;
  idempotentReplay: boolean;
}

const MAX_RACE_RETRIES = 3;

/**
 * Single entry point for wager operations, HTTP and SQS alike (README 10).
 *
 *   1. validate and fingerprint the payload (no I/O)
 *   2. in one SQL transaction:
 *      a. SQS only: register the message in the inbox; seen before => replay
 *      b. existing transaction for (provider, idempotency key)?
 *         same fingerprint => replay; different => 409
 *      c. lock the wallet row (SELECT ... FOR UPDATE)
 *      d. check again under the lock, then decide and write transaction,
 *         balance, ledger entry and outbox events
 *   3. commit; only then the caller answers or acks
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  private readonly logger = new Logger(SubmitWagerTransactionUseCase.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly inbox: InboxRepository,
    private readonly processor: WagerProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: AppMetrics,
  ) {}

  async execute(command: SubmitWagerCommand, source: SubmissionSource = { type: 'HTTP' }): Promise<SubmitWagerResult> {
    const started = performance.now();
    const sourceLabel = source.type === 'HTTP' ? 'http' : 'sqs';
    let outcome: SubmissionOutcome = 'ERROR';
    try {
      const draft = this.draft(command);
      const result = await this.submitWithRaceRetry(draft, command, source);
      outcome = result.idempotentReplay ? 'REPLAY' : result.outcome.status;
      if (!result.idempotentReplay) {
        this.metrics.transactionDecided({ kind: draft.kind, status: result.outcome.status, source: sourceLabel });
      } else if (source.type === 'HTTP') {
        this.metrics.duplicateDetected('http');
      } else if (!result.viaInbox) {
        this.metrics.duplicateDetected('sqs_idempotency_key');
      }
      if (result.viaInbox) this.metrics.duplicateDetected('sqs_inbox');
      return { transactionId: result.transactionId, outcome: result.outcome, idempotentReplay: result.idempotentReplay };
    } catch (error: unknown) {
      outcome = outcomeOf(error);
      throw error;
    } finally {
      this.metrics.submissionCompleted({ source: sourceLabel, kind: command.kind, outcome }, (performance.now() - started) / 1000);
    }
  }

  private async submitWithRaceRetry(
    draft: WagerTransaction,
    command: SubmitWagerCommand,
    source: SubmissionSource,
  ): Promise<SubmitWagerResult & { viaInbox?: boolean }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run(() => this.submit(draft, command, source));
      } catch (error: unknown) {
        // Lost an insert race to a concurrent duplicate: run again, the
        // existing row now decides between replay and conflict.
        if (error instanceof ConcurrentSubmissionError) {
          this.metrics.lockConflict('insert_race');
          if (attempt < MAX_RACE_RETRIES) continue;
        }
        throw error;
      }
    }
  }

  private async submit(
    draft: WagerTransaction,
    command: SubmitWagerCommand,
    source: SubmissionSource,
  ): Promise<SubmitWagerResult & { viaInbox?: boolean }> {
    if (source.type === 'SQS') {
      const now = this.clock.now();
      const message = InboxMessage.receive({
        consumerName: source.consumerName,
        messageId: source.messageId,
        payloadHash: source.messageHash,
        now,
      });
      // Written in the same transaction as the effects: if this row commits,
      // the message is fully processed.
      message.markProcessed(now);
      const fresh = await this.inbox.register(message);
      if (!fresh) return { ...(await this.replayOrConflict(draft)), viaInbox: true };
    }

    const existing = await this.transactions.findByIdempotencyKey(draft.providerId, draft.idempotencyKey);
    if (existing) return this.replay(existing, draft);

    const wallet = await this.wallets.findByIdForUpdate(draft.walletId);
    if (!wallet) {
      throw new UnknownWalletError(`Wallet ${draft.walletId} does not exist`, { walletId: draft.walletId });
    }

    // A duplicate may have committed while we waited for the lock.
    const committedMeanwhile = await this.transactions.findByIdempotencyKey(draft.providerId, draft.idempotencyKey);
    if (committedMeanwhile) return this.replay(committedMeanwhile, draft);

    const tx = draft;
    try {
      await this.processor.process(
        tx,
        wallet,
        { correlationId: command.correlationId, causationId: source.type === 'SQS' ? source.messageId : undefined },
        'insert',
      );
    } catch (error: unknown) {
      // The transaction row is the first write, and ON CONFLICT DO NOTHING
      // keeps the SQL transaction usable, so the conflict can be explained here.
      if (error instanceof ConcurrentSubmissionError) return this.resolveInsertConflict(draft);
      throw error;
    }
    return { transactionId: tx.id, outcome: this.outcomeOf(tx), idempotentReplay: false };
  }

  private async resolveInsertConflict(draft: WagerTransaction): Promise<SubmitWagerResult> {
    const byKey = await this.transactions.findByIdempotencyKey(draft.providerId, draft.idempotencyKey);
    if (byKey) return this.replay(byKey, draft);
    const byExternalId = await this.transactions.findByExternalId(draft.providerId, draft.externalTransactionId);
    if (byExternalId) {
      throw new IdempotencyConflictError('externalTransactionId already submitted with another idempotency key', {
        transactionId: byExternalId.id,
      });
    }
    throw new ConcurrentSubmissionError();
  }

  private async replayOrConflict(draft: WagerTransaction): Promise<SubmitWagerResult> {
    const existing = await this.transactions.findByIdempotencyKey(draft.providerId, draft.idempotencyKey);
    if (!existing) {
      // Inbox has the message but no transaction carries its key: the message
      // was reused with another idempotency key. Never apply it twice.
      throw new IdempotencyConflictError('Message id already processed with a different idempotency key');
    }
    return this.replay(existing, draft);
  }

  private replay(existing: WagerTransaction, draft: WagerTransaction): SubmitWagerResult {
    if (!existing.matchesPayload(draft.payloadHash)) {
      throw new IdempotencyConflictError('Idempotency key already used with a different payload', {
        transactionId: existing.id,
      });
    }
    return { transactionId: existing.id, outcome: this.outcomeOf(existing), idempotentReplay: true };
  }

  private outcomeOf(tx: WagerTransaction): WagerOutcomeSnapshot {
    if (!tx.outcome) throw new Error(`Transaction ${tx.id} has no recorded outcome`);
    return tx.outcome;
  }

  /** Validates the payload and builds the PENDING transaction. Throws INVALID_PAYLOAD. */
  private draft(command: SubmitWagerCommand): WagerTransaction {
    try {
      const money = Money.from(command.money);
      const reference = command.referenceExternalTransactionId ?? null;
      return WagerTransaction.submit({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: wagerFingerprint({ ...command, money: money.toProps(), referenceExternalTransactionId: reference }),
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        amount: money,
        referenceExternalTransactionId: reference,
        now: this.clock.now(),
      });
    } catch (error: unknown) {
      if (error instanceof InvalidValueError) throw new InvalidPayloadError(error.message);
      throw error;
    }
  }
}

function outcomeOf(error: unknown): SubmissionOutcome {
  if (error instanceof ApplicationError) {
    if (error.category === 'VALIDATION') return 'INVALID';
    if (error.category === 'CONFLICT') return 'CONFLICT';
    if (error.category === 'BUSINESS' || error.category === 'NOT_FOUND') return 'BUSINESS_ERROR';
  }
  return 'ERROR';
}
