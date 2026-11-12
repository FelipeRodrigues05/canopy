import { Injectable } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { IdGenerator } from '../../../shared/application/id-generator';
import type { EventContext, IntegrationEvent } from '../../../shared/domain/integration-event';
import { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { LedgerRepository } from '../../wallet/application/ports/ledger.repository';
import { WalletRepository } from '../../wallet/application/ports/wallet.repository';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.event';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event';
import { FailureCode } from '../domain/failure-code';
import { type WagerDecision, WagerPolicy } from '../domain/wager-policy';
import type { WagerTransaction } from '../domain/wager-transaction';
import { ConcurrentSubmissionError } from './wagering.errors';
import { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { WageringConfig, pendingReferenceDelayMs } from './wagering.config';

export interface ProcessContext {
  correlationId: string;
  causationId?: string | undefined;
}

export type PersistMode = 'insert' | 'update';

/**
 * Applies one transaction to its wallet. Shared by the submit use case (new
 * transactions) and the pending-reference worker (transactions waiting for
 * their reference), so both follow exactly the same rules.
 *
 * Preconditions: runs inside a UnitOfWork, and `wallet` was read with
 * findByIdForUpdate in that same transaction. The wallet row lock is what
 * serializes every balance change of a wallet across all instances.
 */
@Injectable()
export class WagerProcessor {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly config: WageringConfig,
  ) {}

  /**
   * Decides, mutates `tx` and `wallet`, and writes everything: transaction row,
   * wallet balance, ledger entry and outbox events. Write order matters: the
   * transaction row first (ledger FK), then the wallet, then its ledger entry
   * (the ledger trigger checks the entry against the updated wallet row).
   */
  async process(tx: WagerTransaction, wallet: Wallet, ctx: ProcessContext, mode: PersistMode): Promise<WagerDecision> {
    const now = this.clock.now();
    const decision = await this.decide(tx, wallet);
    const versionBefore = wallet.version;
    const events: IntegrationEvent<object>[] = [];
    let entry: WalletLedgerEntry | null = null;
    const eventCtx = (): EventContext => ({ ...ctx, eventId: this.ids.next() });

    switch (decision.type) {
      case 'awaitReference':
        if (tx.status === 'PENDING') {
          tx.awaitReference(new Date(now.getTime() + pendingReferenceDelayMs(this.config, 0)));
          events.push(WagerTransactionPendingReference.from(tx, eventCtx(), now));
        } else if (tx.referenceAttempts + 1 >= this.config.pendingReferenceMaxAttempts) {
          tx.reject(FailureCode.REFERENCE_NOT_FOUND, now);
          events.push(WagerTransactionRejected.from(tx, eventCtx()));
        } else {
          const attempt = tx.referenceAttempts + 1;
          tx.registerReferenceAttempt(new Date(now.getTime() + pendingReferenceDelayMs(this.config, attempt)));
        }
        break;
      case 'reject':
        tx.reject(decision.code, now, decision.referenceTransactionId);
        events.push(WagerTransactionRejected.from(tx, eventCtx()));
        break;
      case 'noop':
        tx.markProcessed(now, decision.referenceTransactionId);
        events.push(WagerTransactionProcessed.from(tx, eventCtx()));
        break;
      case 'apply': {
        const movement = { entryId: this.ids.next(), transactionId: tx.id, amount: tx.amount, at: now };
        entry =
          decision.operation === 'debit'
            ? wallet.debit(movement)
            : decision.operation === 'credit'
              ? wallet.credit(movement)
              : wallet.reverseCredit(movement);
        tx.markProcessed(now, decision.referenceTransactionId);
        events.push(WagerTransactionProcessed.from(tx, eventCtx()));
        events.push(WalletBalanceChanged.from(wallet, entry, eventCtx()));
        break;
      }
    }

    if (tx.status === 'PROCESSED' || tx.status === 'REJECTED' || tx.status === 'PENDING_REFERENCE') {
      // First answer only: a later outcome never replaces it (A5).
      tx.recordOutcome({
        status: tx.status,
        failureCode: tx.failureCode,
        balance: wallet.balance.toProps(),
        walletVersion: wallet.version,
        decidedAt: now.toISOString(),
      });
    }

    if (mode === 'insert') {
      if (!(await this.transactions.insertIfAbsent(tx))) throw new ConcurrentSubmissionError();
    } else {
      await this.transactions.update(tx);
    }
    if (entry) {
      await this.wallets.saveBalance(wallet, versionBefore);
      await this.ledger.append(entry);
    }
    await this.outbox.add(events.map((e) => OutboxMessage.enqueue(e)));
    if (tx.isTerminal) {
      // Anything parked waiting for this transaction can be decided now.
      await this.transactions.expediteWaitingFor(tx.providerId, tx.externalTransactionId, now);
    }
    return decision;
  }

  private async decide(tx: WagerTransaction, wallet: Wallet): Promise<WagerDecision> {
    const reference =
      tx.referenceExternalTransactionId === null
        ? null
        : await this.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
    const referenceAlreadyReversed =
      reference !== null && (tx.kind === 'REFUND' || tx.kind === 'ROLLBACK')
        ? await this.transactions.hasProcessedReversal(reference.id)
        : false;
    return WagerPolicy.decide({ transaction: tx, wallet, reference, referenceAlreadyReversed });
  }
}
