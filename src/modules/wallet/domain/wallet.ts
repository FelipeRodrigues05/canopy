import type { Currency } from '../../../shared/domain/currency';
import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { CurrencyMismatchError, Money } from '../../../shared/domain/money';
import { type LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, ReversalWouldOverdrawError } from './wallet.errors';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: Currency;
  balance: Money;
  /** 1 when opened; +1 on every balance change (= sequence of the latest ledger entry). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMovement {
  entryId: string;
  transactionId: string;
  amount: Money;
  at: Date;
}

export interface WalletOpening {
  wallet: Wallet;
  /** CREDIT entry of the OPENING transaction; null when the initial balance is zero. */
  openingEntry: WalletLedgerEntry | null;
}

/**
 * Wallet aggregate: the balance of one player in one currency.
 *
 * `version` starts at 1 when the wallet opens and grows by exactly one each
 * time the balance changes (README 6.2). Every change goes through
 * `debit`/`credit`/`reverseCredit` and returns the ledger entry that explains
 * it, with `sequence` = the version after the change, so the ledger of a
 * wallet is numbered by the same counter that orders its balance changes.
 * The persistence layer stores wallet and entry in the same SQL transaction.
 */
export class Wallet {
  private constructor(private props: WalletProps) {}

  /**
   * Opens a wallet. A positive initial balance is applied as the CREDIT of the
   * internal OPENING transaction and becomes ledger entry #1.
   */
  static open(input: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now: Date;
    opening: { entryId: string; transactionId: string };
  }): WalletOpening {
    if (input.initialBalance.isNegative()) {
      throw new InvariantViolationError('Initial balance cannot be negative');
    }
    const wallet = new Wallet({
      id: input.id,
      playerId: input.playerId,
      currency: input.initialBalance.currency,
      balance: Money.zero(input.initialBalance.currency),
      version: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
    if (input.initialBalance.isZero()) {
      wallet.props = { ...wallet.props, version: 1 };
      return { wallet, openingEntry: null };
    }
    const openingEntry = wallet.credit({
      entryId: input.opening.entryId,
      transactionId: input.opening.transactionId,
      amount: input.initialBalance,
      at: input.now,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state. Does not re-run any rule (README 6.0). */
  static rehydrate(props: WalletProps): Wallet {
    return new Wallet({ ...props });
  }

  canDebit(amount: Money): boolean {
    return !this.props.balance.isLessThan(amount);
  }

  /** BET. Throws InsufficientFundsError when the balance does not cover it. */
  debit(movement: BalanceMovement): WalletLedgerEntry {
    if (!this.canDebit(movement.amount)) {
      throw new InsufficientFundsError(`Insufficient funds in wallet ${this.props.id}`);
    }
    return this.apply('DEBIT', movement);
  }

  /** WIN, REFUND, OPENING and ROLLBACK of a BET. */
  credit(movement: BalanceMovement): WalletLedgerEntry {
    return this.apply('CREDIT', movement);
  }

  /** ROLLBACK of a WIN or REFUND. Throws ReversalWouldOverdrawError instead of going negative. */
  reverseCredit(movement: BalanceMovement): WalletLedgerEntry {
    if (!this.canDebit(movement.amount)) {
      throw new ReversalWouldOverdrawError(`Reversal would overdraw wallet ${this.props.id}`);
    }
    return this.apply('DEBIT', movement);
  }

  private apply(direction: LedgerDirection, m: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(m.amount);
    if (!m.amount.isPositive()) {
      throw new InvariantViolationError('Zero amounts do not move the balance; do not call debit/credit');
    }
    const balanceBefore = this.props.balance;
    const balanceAfter = direction === 'CREDIT' ? balanceBefore.add(m.amount) : balanceBefore.subtract(m.amount);
    const entry = WalletLedgerEntry.create({
      id: m.entryId,
      walletId: this.props.id,
      transactionId: m.transactionId,
      sequence: this.props.version + 1,
      direction,
      amount: m.amount,
      balanceBefore,
      balanceAfter,
      createdAt: m.at,
    });
    this.props = { ...this.props, balance: balanceAfter, version: entry.sequence, updatedAt: m.at };
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (!money.currency.equals(this.props.currency)) {
      throw new CurrencyMismatchError(this.props.currency.code, money.currency.code);
    }
  }

  get id(): string {
    return this.props.id;
  }
  get playerId(): string {
    return this.props.playerId;
  }
  get currency(): Currency {
    return this.props.currency;
  }
  get balance(): Money {
    return this.props.balance;
  }
  get version(): number {
    return this.props.version;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
