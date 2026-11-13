import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from './money';
import { InvalidValueError } from './domain-error';

describe('Money', () => {
  describe('from (parsing untrusted input)', () => {
    it.each([
      ['0', '0.00'],
      ['10', '10.00'],
      ['10.5', '10.50'],
      ['10.55', '10.55'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('accepts %p and always renders 2 places (%p)', (input, expected) => {
      expect(Money.from(input, 'BRL').toString()).toBe(expected);
    });

    it.each([
      ['empty', ''],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['negative', '-1.00'],
      ['explicit plus', '+1.00'],
      ['scientific', '1e3'],
      ['scientific with decimals', '1.5E2'],
      ['more than 2 decimals', '1.234'],
      ['trailing dot', '1.'],
      ['leading dot', '.5'],
      ['leading zeros', '007.00'],
      ['whitespace', ' 1.00'],
      ['comma decimal', '1,00'],
      ['hex', '0x10'],
      ['too many integer digits', '1000000000000000000.00'],
    ])('rejects %s (%p)', (_label, input) => {
      expect(() => Money.from(input, 'BRL')).toThrow(InvalidValueError);
    });

    it('rejects a JS number smuggled in at runtime', () => {
      expect(() => Money.from(10 as unknown as string, 'BRL')).toThrow(InvalidValueError);
    });

    it('rejects invalid currencies', () => {
      expect(() => Money.from('1.00', 'brl')).toThrow(InvalidValueError);
      expect(() => Money.from('1.00', 'REAL')).toThrow(InvalidValueError);
    });
  });

  describe('arithmetic is exact', () => {
    it('0.10 + 0.20 is exactly 0.30 (no binary float drift)', () => {
      const sum = Money.from('0.10', 'BRL').add(Money.from('0.20', 'BRL'));
      expect(sum.equals(Money.from('0.30', 'BRL'))).toBe(true);
      expect(sum.toString()).toBe('0.30');
    });

    it('keeps precision at the top of the range', () => {
      const big = Money.from('999999999999999998.99', 'BRL').add(Money.from('1.00', 'BRL'));
      expect(big.toString()).toBe('999999999999999999.99');
    });

    it('subtracts exactly, below zero too (the Wallet, not Money, forbids negative balances)', () => {
      const balance = Money.from('100.00', 'BRL');
      expect(balance.subtract(Money.from('100.00', 'BRL')).isZero()).toBe(true);
      const negative = balance.subtract(Money.from('100.01', 'BRL'));
      expect(negative.isNegative()).toBe(true);
      expect(negative.toString()).toBe('-0.01');
      expect(negative.negate().toString()).toBe('0.01');
      expect(Money.zero('BRL').negate().toString()).toBe('0.00');
      expect(Money.from('1', 'BRL').isPositive()).toBe(true);
    });

    it('is immutable', () => {
      const a = Money.from('5.00', 'BRL');
      a.add(Money.from('1.00', 'BRL'));
      expect(a.toString()).toBe('5.00');
    });
  });

  describe('rounding (multiply is the only operation that rounds)', () => {
    it.each([
      ['10.00', '0.125', '1.25'], // 1.25 exactly
      ['0.05', '0.5', '0.02'], // 0.025 -> 0.02 (half to even)
      ['0.15', '0.5', '0.08'], // 0.075 -> 0.08 (half to even)
      ['1.00', '0.333', '0.33'],
      ['2.00', '0.335', '0.67'],
    ])('%p x %p = %p with HALF_EVEN', (amount, factor, expected) => {
      expect(Money.from(amount, 'BRL').multiply(factor).toString()).toBe(expected);
    });

    it('rejects non-decimal factors', () => {
      expect(() => Money.from('1.00', 'BRL').multiply('1e2')).toThrow(InvalidValueError);
    });
  });

  describe('currency', () => {
    it('refuses to mix currencies', () => {
      const brl = Money.from('1.00', 'BRL');
      const usd = Money.from('1.00', 'USD');
      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.compare(usd)).toThrow(CurrencyMismatchError);
      expect(brl.equals(usd)).toBe(false);
    });
  });

  it('compares', () => {
    const one = Money.from('1.00', 'BRL');
    const two = Money.from('2', 'BRL');
    expect(one.isLessThan(two)).toBe(true);
    expect(two.isGreaterThan(one)).toBe(true);
    expect(one.compare(Money.from('1', 'BRL'))).toBe(0);
  });

  it('serializes to string props, never numbers', () => {
    const props = Money.from('12.3', 'BRL').toProps();
    expect(props).toEqual({ amount: '12.30', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify({ m: Money.from('1', 'USD') }))).toEqual({ m: { amount: '1.00', currency: 'USD' } });
    expect(Money.from(props).equals(Money.from('12.30', 'BRL'))).toBe(true);
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidValueError);
  });
});
