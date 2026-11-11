import { Currency } from '../../../shared/domain/currency';
import { Money } from '../../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { LedgerEntryRecord, WalletRecord } from './wallet.orm-entity';

/**
 * numeric(20,2) arrives as a string ("975.00") and goes straight into Money.
 * This is the only place where database rows become domain objects.
 */
export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: Currency.from(r.currency),
      balance: Money.from(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },

  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency.code,
      balance: w.balance.toString(),
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      sequence: r.sequence,
      direction: r.direction,
      amount: Money.from(r.amount, r.currency),
      balanceBefore: Money.from(r.balanceBefore, r.currency),
      balanceAfter: Money.from(r.balanceAfter, r.currency),
      createdAt: r.createdAt,
    });
  },

  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      sequence: e.sequence,
      direction: e.direction,
      amount: e.amount.toString(),
      currency: e.amount.currency.code,
      balanceBefore: e.balanceBefore.toString(),
      balanceAfter: e.balanceAfter.toString(),
      createdAt: e.createdAt,
    };
  },
};
