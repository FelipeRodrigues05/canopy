import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Sequence to continue from, or null at the end. */
  nextBeforeSequence: number | null;
}

export abstract class LedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first. `beforeSequence` is exclusive. */
  abstract page(walletId: string, options: { beforeSequence: number | null; limit: number }): Promise<LedgerPage>;
}
