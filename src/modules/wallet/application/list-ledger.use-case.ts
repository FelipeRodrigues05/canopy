import { Injectable } from '@nestjs/common';
import type { MoneyProps } from '../../../shared/domain/money';
import { LedgerRepository } from './ports/ledger.repository';
import { WalletRepository } from './ports/wallet.repository';
import { WalletNotFoundError } from './wallet.errors';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  sequence: number;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  /** Pass back as `beforeSequence` for the next page; null at the end. */
  nextBeforeSequence: number | null;
}

@Injectable()
export class ListLedgerUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  /** Newest first, keyset pagination on (wallet_id, sequence): stable under concurrent inserts. */
  async execute(walletId: string, options: { beforeSequence: number | null; limit: number }): Promise<LedgerPageView> {
    if (!(await this.wallets.findById(walletId))) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`, { walletId });
    }
    const page = await this.ledger.page(walletId, options);
    return {
      items: page.items.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        sequence: e.sequence,
        direction: e.direction,
        money: e.amount.toProps(),
        balanceBefore: e.balanceBefore.toProps(),
        balanceAfter: e.balanceAfter.toProps(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextBeforeSequence: page.nextBeforeSequence,
    };
  }
}
