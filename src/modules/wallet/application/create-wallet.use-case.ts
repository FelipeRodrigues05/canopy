import { Injectable } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { IdGenerator } from '../../../shared/application/id-generator';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransactionRepository } from '../../wagering/application/ports/wager-transaction.repository';
import { wagerFingerprint } from '../../wagering/application/wager-fingerprint';
import { WagerTransactionProcessed } from '../../wagering/domain/events/wager-transaction-processed.event';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.event';
import { Wallet } from '../domain/wallet';
import { LedgerRepository } from './ports/ledger.repository';
import { WalletRepository } from './ports/wallet.repository';
import { type WalletView, toWalletView } from './wallet.view';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * RF01. Wallet, OPENING transaction, CREDIT ledger entry and outbox events are
 * written in one SQL transaction: either the wallet exists with its funded
 * history, or nothing does.
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);

    return this.uow.run(async () => {
      const now = this.clock.now();
      const walletId = this.ids.next();
      const openingTxId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance,
        now,
        opening: { entryId: this.ids.next(), transactionId: openingTxId },
      });

      await this.wallets.insert(wallet);
      if (openingEntry === null) return toWalletView(wallet);

      const opening = WagerTransaction.opening({
        id: openingTxId,
        walletId,
        playerId: command.playerId,
        amount: initialBalance,
        payloadHash: wagerFingerprint({
          providerId: 'canopy',
          externalTransactionId: `opening:${walletId}`,
          walletId,
          playerId: command.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: 'OPENING',
          money: initialBalance.toProps(),
        }),
        now,
      });
      opening.markProcessed(now);
      opening.recordOutcome({
        status: 'PROCESSED',
        failureCode: null,
        balance: wallet.balance.toProps(),
        walletVersion: wallet.version,
        decidedAt: now.toISOString(),
      });

      await this.transactions.insert(opening);
      await this.ledger.append(openingEntry);
      const ctx = { correlationId: command.correlationId };
      await this.outbox.add([
        OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, { ...ctx, eventId: this.ids.next() })),
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, { ...ctx, eventId: this.ids.next() })),
      ]);
      return toWalletView(wallet);
    });
  }
}
