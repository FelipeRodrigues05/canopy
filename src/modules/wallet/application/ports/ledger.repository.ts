import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Sequence to continue from, or null at the end. */
  nextBeforeSequence: number | null;
}

/** Ledger totals as exact decimal strings (never numbers). */
export interface LedgerSummary {
  credits: string;
  debits: string;
  entries: number;
  lastSequence: number | null;
  lastBalanceAfter: string | null;
}

export abstract class LedgerRepository {
  /** Sums computed by Postgres over numeric columns: exact, no float on the way. */
  abstract summarize(walletId: string): Promise<LedgerSummary>;
  abstract append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first. `beforeSequence` is exclusive. */
  abstract page(walletId: string, options: { beforeSequence: number | null; limit: number }): Promise<LedgerPage>;
}
