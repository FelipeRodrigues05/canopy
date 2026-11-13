import { type EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import type { Wallet } from '../wallet';

export interface WalletBalanceChangedData {
  walletId: string;
  playerId: string;
  transactionId: string;
  ledgerEntryId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted only when a balance actually moved (never for LOSS, rejections or zero amounts). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged' as const;
  readonly version = 1 as const;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      occurredAt: entry.createdAt,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: entry.transactionId,
        ledgerEntryId: entry.id,
        direction: entry.direction,
        money: entry.amount.toProps(),
        balanceBefore: entry.balanceBefore.toProps(),
        balanceAfter: entry.balanceAfter.toProps(),
        walletVersion: entry.sequence,
      },
    });
  }
}
