import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { Money } from '../../../shared/domain/money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** Position in the wallet's history: equals the wallet version after this entry (1, 2, 3, ...). */
  sequence: number;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * One immutable line of a wallet's history. The arithmetic is checked here and
 * again by a CHECK constraint in the database; nothing can ever update it.
 */
export class WalletLedgerEntry {
  private constructor(private readonly props: WalletLedgerEntryProps) {}

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.validate(props);
    return new WalletLedgerEntry({ ...props });
  }

  /** Rebuilds persisted state without re-running rules (README 6.0). */
  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...props });
  }

  /** balanceBefore ± amount === balanceAfter. */
  isBalanced(): boolean {
    const p = this.props;
    const expected = p.direction === 'CREDIT' ? p.balanceBefore.add(p.amount) : p.balanceBefore.subtract(p.amount);
    return expected.equals(p.balanceAfter);
  }

  private static validate(p: WalletLedgerEntryProps): void {
    if (!p.amount.isPositive()) {
      throw new InvariantViolationError('Ledger entry amount must be greater than zero');
    }
    if (!Number.isSafeInteger(p.sequence) || p.sequence < 1) {
      throw new InvariantViolationError('Ledger sequence must be a positive integer');
    }
    if (p.balanceBefore.isNegative() || p.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger balances cannot be negative');
    }
    if (!new WalletLedgerEntry(p).isBalanced()) {
      throw new InvariantViolationError(
        `Ledger arithmetic broken: ${p.balanceBefore.toString()} ${p.direction} ${p.amount.toString()} != ${p.balanceAfter.toString()}`,
      );
    }
  }

  get id(): string {
    return this.props.id;
  }
  get walletId(): string {
    return this.props.walletId;
  }
  get transactionId(): string {
    return this.props.transactionId;
  }
  get sequence(): number {
    return this.props.sequence;
  }
  get direction(): LedgerDirection {
    return this.props.direction;
  }
  get amount(): Money {
    return this.props.amount;
  }
  get balanceBefore(): Money {
    return this.props.balanceBefore;
  }
  get balanceAfter(): Money {
    return this.props.balanceAfter;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
}
