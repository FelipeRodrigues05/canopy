import { Decimal as BaseDecimal } from 'decimal.js';
import { Currency } from './currency';
import { InvalidValueError, InvariantViolationError } from './domain-error';

/**
 * Isolated Decimal constructor so no other code can change the global
 * precision or rounding mode under us. HALF_EVEN (banker's rounding) is the
 * financial default: it does not bias sums of many rounded values upward.
 */
const Decimal = BaseDecimal.clone({
  precision: 40,
  rounding: BaseDecimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
type Decimal = InstanceType<typeof Decimal>;

export const MONEY_SCALE = 2;
/** numeric(20,2): 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;

/**
 * Plain decimal: digits, optional dot and 0 to 2 decimals (A6). No sign, no
 * exponent, no whitespace, no leading zeros. Rejecting here is what keeps NaN,
 * Infinity, "1e3", "-5", "" and "1.234" out of the system.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** Serialized form for contracts, events and snapshots. Never a JS number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Amount of a currency with exactly 2 decimal places. Immutable: every
 * operation returns a new instance. Operations between different currencies
 * throw (there is no conversion).
 *
 * Parsing (`from`) only accepts non-negative input, because negative values
 * are invalid in every input contract. Arithmetic may go below zero (a
 * reconciliation difference, for instance); it is the Wallet, not Money, that
 * forbids a negative balance.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: Currency,
  ) {}

  /** Parses untrusted input (API, queue, database): `from({ amount, currency })` or `from(amount, currency)`. */
  static from(props: MoneyProps): Money;
  static from(amount: string, currency: string | Currency): Money;
  static from(amountOrProps: string | MoneyProps, maybeCurrency?: string | Currency): Money {
    if (typeof amountOrProps === 'object' && amountOrProps !== null) {
      return Money.from(amountOrProps.amount, amountOrProps.currency);
    }
    const amount = amountOrProps;
    const currency = maybeCurrency ?? '';
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidValueError(`Invalid money amount: ${JSON.stringify(amount)}`);
    }
    const integerDigits = amount.split('.')[0]?.length ?? 0;
    if (integerDigits > MAX_INTEGER_DIGITS) {
      throw new InvalidValueError(`Money amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(new Decimal(amount), Money.currencyOf(currency));
  }

  static zero(currency: string | Currency): Money {
    return new Money(new Decimal(0), Money.currencyOf(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.with(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.with(this.value.minus(other.value));
  }

  negate(): Money {
    return this.with(this.value.negated());
  }

  /**
   * Multiplies by a decimal factor given as a string and rounds back to 2
   * places with HALF_EVEN. The only operation here that rounds.
   */
  multiply(factor: string): Money {
    if (!/^\d+(\.\d+)?$/.test(factor)) {
      throw new InvalidValueError(`Invalid factor: ${JSON.stringify(factor)}`);
    }
    return this.with(this.value.times(new Decimal(factor)).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_EVEN));
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency.equals(other.currency) && this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isGreaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  isLessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  /** Always 2 decimal places: "10" in, "10.00" out. */
  toString(): string {
    // toFixed on -0 would print "-0.00"
    return this.value.isZero() ? (0).toFixed(MONEY_SCALE) : this.value.toFixed(MONEY_SCALE);
  }

  toProps(): MoneyProps {
    return { amount: this.toString(), currency: this.currency.code };
  }

  toJSON(): MoneyProps {
    return this.toProps();
  }

  private with(value: Decimal): Money {
    return new Money(value, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw new CurrencyMismatchError(this.currency.code, other.currency.code);
    }
  }

  private static currencyOf(currency: string | Currency): Currency {
    return currency instanceof Currency ? currency : Currency.from(currency);
  }
}

export class CurrencyMismatchError extends InvariantViolationError {
  override readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
