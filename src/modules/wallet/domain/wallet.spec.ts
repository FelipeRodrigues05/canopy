import { describe, expect, it } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/money';
import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { Currency } from '../../../shared/domain/currency';
import { Wallet } from './wallet';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, ReversalWouldOverdrawError } from './wallet.errors';

const now = new Date('2026-11-11T12:00:00Z');
const brl = (amount: string) => Money.from(amount, 'BRL');
let seq = 0;
const move = (amount: string, currency = 'BRL') => ({
  entryId: `entry-${++seq}`,
  transactionId: `tx-${seq}`,
  amount: Money.from(amount, currency),
  at: now,
});

const opening = { entryId: 'opening-entry', transactionId: 'opening-tx' };

function walletWith(balance: string): Wallet {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance), now, opening }).wallet;
}

describe('Wallet', () => {
  it('opens with zero balance at version 1 and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('0'), now, opening });
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  it('opens with a positive balance as OPENING credit = ledger entry #1, version 1', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('1000.00'), now, opening });
    expect(wallet.version).toBe(1);
    expect(wallet.currency.code).toBe('BRL');
    expect(openingEntry).toMatchObject({ sequence: 1, direction: 'CREDIT', transactionId: 'opening-tx' });
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
  });

  it('version only grows when the balance changes', () => {
    const wallet = walletWith('0');
    expect(() => wallet.debit(move('0.01'))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(1);
    expect(wallet.credit(move('5.00')).sequence).toBe(2);
    expect(wallet.version).toBe(2);
  });

  it('credit moves the balance and returns the ledger entry with the next sequence', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.credit(move('25.50'));
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('125.50');
    expect(entry.sequence).toBe(2);
    expect(wallet.version).toBe(2);
    expect(wallet.balance.equals(brl('125.50'))).toBe(true);
  });

  it('debit down to exactly zero is allowed', () => {
    const wallet = walletWith('80.00');
    const entry = wallet.debit(move('80.00'));
    expect(entry.balanceAfter.isZero()).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('debit beyond the balance throws InsufficientFunds and changes nothing', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.debit(move('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('reverting a credit beyond the balance throws a distinct error', () => {
    const wallet = walletWith('10.00');
    expect(() => wallet.reverseCredit(move('10.01'))).toThrow(ReversalWouldOverdrawError);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  it('two 80.00 debits on 100.00: the second one fails', () => {
    const wallet = walletWith('100.00');
    wallet.debit(move('80.00'));
    expect(() => wallet.debit(move('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  it('refuses operations in another currency', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.credit(move('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(move('1.00', 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('refuses zero movements (they never reach the ledger)', () => {
    const wallet = walletWith('1.00');
    expect(() => wallet.credit(move('0.00'))).toThrow(InvariantViolationError);
  });

  it('rehydrate rebuilds persisted state as is', () => {
    const wallet = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: Currency.from('BRL'), balance: brl('7.00'), version: 9, createdAt: now, updatedAt: now,
    });
    expect(wallet.version).toBe(9);
    expect(wallet.debit(move('7.00')).sequence).toBe(10);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1', walletId: 'w1', transactionId: 't1', sequence: 1, direction: 'CREDIT' as const,
    amount: brl('10.00'), balanceBefore: brl('5.00'), balanceAfter: brl('15.00'), createdAt: now,
  };

  it('rehydrate does not re-validate, isBalanced tells', () => {
    const broken = WalletLedgerEntry.rehydrate({ ...base, balanceAfter: brl('99.00') });
    expect(broken.isBalanced()).toBe(false);
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  it('accepts consistent arithmetic', () => {
    expect(WalletLedgerEntry.create(base).balanceAfter.toString()).toBe('15.00');
    expect(WalletLedgerEntry.create({ ...base, direction: 'DEBIT', balanceAfter: brl('0.00'), balanceBefore: brl('10.00') }).sequence).toBe(1);
  });

  it('rejects broken arithmetic, zero amounts and bad sequences', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('15.01') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, amount: brl('0'), balanceAfter: brl('5.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, sequence: 0 })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: 'DEBIT', balanceBefore: brl('5.00'), balanceAfter: brl('0.00') })).toThrow(InvariantViolationError);
  });
});
