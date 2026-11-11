import { InvalidValueError } from './domain-error';

const ISO_4217 = /^[A-Z]{3}$/;

/** ISO 4217 alphabetic code. The model is multi-currency; no conversion happens. */
export class Currency {
  private constructor(readonly code: string) {}

  static from(code: string): Currency {
    if (typeof code !== 'string' || !ISO_4217.test(code)) {
      throw new InvalidValueError(`Invalid currency code: ${JSON.stringify(code)}`);
    }
    return new Currency(code);
  }

  equals(other: Currency): boolean {
    return this.code === other.code;
  }

  toString(): string {
    return this.code;
  }
}
