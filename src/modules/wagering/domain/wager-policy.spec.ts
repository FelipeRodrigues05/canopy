import { describe, expect, it } from 'bun:test';
import { NOW, processed, tx, wallet } from './__fixtures__/wager.fixtures';
import { WagerPolicy, type WagerDecision } from './wager-policy';
import type { WagerTransaction } from './wager-transaction';

function decide(
  transaction: WagerTransaction,
  opts: { balance?: string; reference?: WagerTransaction | null; reversed?: boolean; playerId?: string; currency?: string } = {},
): WagerDecision {
  const w = wallet(opts.balance ?? '100.00', {
    ...(opts.playerId ? { playerId: opts.playerId } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
  });
  return WagerPolicy.decide({
    transaction,
    wallet: w,
    reference: opts.reference ?? null,
    referenceAlreadyReversed: opts.reversed ?? false,
  });
}

const bet = (amount = '10.00', extra: Parameters<typeof tx>[0] = {}) => tx({ kind: 'BET', amount, ...extra });
const ref = (t: WagerTransaction) => ({ referenceExternalTransactionId: t.externalTransactionId });

describe('WagerPolicy', () => {
  describe('wallet checks', () => {
    it('wallet of another player', () => {
      expect(decide(bet(), { playerId: 'someone-else' })).toMatchObject({ type: 'reject', code: 'WALLET_PLAYER_MISMATCH' });
    });

    it('operation currency differs from the wallet', () => {
      expect(decide(bet('1.00', { currency: 'USD' }))).toMatchObject({ type: 'reject', code: 'CURRENCY_MISMATCH' });
    });
  });

  describe('BET (RF02)', () => {
    it('debits when the balance covers it, including exactly', () => {
      expect(decide(bet('100.00'))).toMatchObject({ type: 'apply', operation: 'debit' });
    });

    it('rejects INSUFFICIENT_FUNDS', () => {
      expect(decide(bet('100.01'))).toMatchObject({ type: 'reject', code: 'INSUFFICIENT_FUNDS' });
    });

    it('zero amount moves nothing', () => {
      expect(decide(bet('0.00'))).toMatchObject({ type: 'noop' });
    });
  });

  describe('WIN (RF03)', () => {
    it('credits without reference', () => {
      expect(decide(tx({ kind: 'WIN' }), { balance: '0.00' })).toMatchObject({ type: 'apply', operation: 'credit', referenceTransactionId: null });
    });

    it('credits with a processed BET of the same round as reference', () => {
      const b = processed(bet());
      expect(decide(tx({ kind: 'WIN', amount: '50.00', ...ref(b) }), { reference: b })).toMatchObject({
        type: 'apply', operation: 'credit', referenceTransactionId: b.id,
      });
    });

    it('a referenced WIN must point at a BET', () => {
      const win = processed(tx({ kind: 'WIN' }));
      expect(decide(tx({ kind: 'WIN', ...ref(win) }), { reference: win })).toMatchObject({ type: 'reject', code: 'INVALID_REFERENCE_KIND' });
    });
  });

  describe('LOSS (RF04)', () => {
    it('never touches the balance', () => {
      expect(decide(tx({ kind: 'LOSS' }), { balance: '0.00' })).toMatchObject({ type: 'noop' });
    });
  });

  describe('REFUND (RF05)', () => {
    it('credits the amount of a processed BET', () => {
      const b = processed(bet('30.00'));
      expect(decide(tx({ kind: 'REFUND', amount: '30.00', ...ref(b) }), { reference: b })).toMatchObject({
        type: 'apply', operation: 'credit', referenceTransactionId: b.id,
      });
    });

    it('only of a BET', () => {
      const win = processed(tx({ kind: 'WIN' }));
      expect(decide(tx({ kind: 'REFUND', ...ref(win) }), { reference: win })).toMatchObject({ type: 'reject', code: 'INVALID_REFERENCE_KIND' });
    });

    it('same amount only (no partial reversal)', () => {
      const b = processed(bet('30.00'));
      expect(decide(tx({ kind: 'REFUND', amount: '29.99', ...ref(b) }), { reference: b })).toMatchObject({ type: 'reject', code: 'AMOUNT_MISMATCH' });
    });

    it('only once', () => {
      const b = processed(bet());
      expect(decide(tx({ kind: 'REFUND', ...ref(b) }), { reference: b, reversed: true })).toMatchObject({ type: 'reject', code: 'ALREADY_REVERSED' });
    });

    it('only of a PROCESSED BET', () => {
      const b = bet();
      b.reject('INSUFFICIENT_FUNDS', NOW);
      expect(decide(tx({ kind: 'REFUND', ...ref(b) }), { reference: b })).toMatchObject({ type: 'reject', code: 'REFERENCE_NOT_PROCESSED' });
    });
  });

  describe('ROLLBACK (RF06, RF09)', () => {
    it('of a BET gives the money back', () => {
      const b = processed(bet('40.00'));
      expect(decide(tx({ kind: 'ROLLBACK', amount: '40.00', ...ref(b) }), { reference: b, balance: '0.00' })).toMatchObject({
        type: 'apply', operation: 'credit',
      });
    });

    it.each(['WIN', 'REFUND'] as const)('of a %s takes the money again', (kind) => {
      const credit = processed(tx({ kind: kind === 'REFUND' ? 'WIN' : kind, amount: '40.00' }));
      expect(decide(tx({ kind: 'ROLLBACK', amount: '40.00', ...ref(credit) }), { reference: credit })).toMatchObject({
        type: 'apply', operation: 'reverseCredit',
      });
    });

    it('of a REFUND is allowed (it references the REFUND, not the BET)', () => {
      const b = processed(bet('40.00'));
      const refund = processed(tx({ kind: 'REFUND', amount: '40.00', ...ref(b) }));
      expect(decide(tx({ kind: 'ROLLBACK', amount: '40.00', ...ref(refund) }), { reference: refund })).toMatchObject({
        type: 'apply', operation: 'reverseCredit',
      });
    });

    it('that would overdraw is REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_FUNDS', () => {
      const win = processed(tx({ kind: 'WIN', amount: '40.00' }));
      expect(decide(tx({ kind: 'ROLLBACK', amount: '40.00', ...ref(win) }), { reference: win, balance: '39.99' })).toMatchObject({
        type: 'reject', code: 'REVERSAL_WOULD_OVERDRAW',
      });
    });

    it.each(['LOSS', 'ROLLBACK'] as const)('of a %s is an invalid reference kind', (kind) => {
      const target =
        kind === 'LOSS'
          ? processed(tx({ kind: 'LOSS' }))
          : processed(tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'something' }));
      expect(decide(tx({ kind: 'ROLLBACK', amount: target.amount.toString(), ...ref(target) }), { reference: target })).toMatchObject({
        type: 'reject', code: 'INVALID_REFERENCE_KIND',
      });
    });

    it('only once, whatever the first reversal was (A3)', () => {
      const b = processed(bet());
      expect(decide(tx({ kind: 'ROLLBACK', ...ref(b) }), { reference: b, reversed: true })).toMatchObject({ type: 'reject', code: 'ALREADY_REVERSED' });
    });

    it('same amount only', () => {
      const b = processed(bet('10.00'));
      expect(decide(tx({ kind: 'ROLLBACK', amount: '10.01', ...ref(b) }), { reference: b })).toMatchObject({ type: 'reject', code: 'AMOUNT_MISMATCH' });
    });
  });

  describe('reference resolution (RF07, RF08)', () => {
    it('missing reference waits', () => {
      expect(decide(tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'not-yet' }))).toEqual({ type: 'awaitReference' });
    });

    it('reference still pending its own reference waits too', () => {
      const pendingRefund = tx({ kind: 'REFUND', referenceExternalTransactionId: 'bet-not-yet' });
      pendingRefund.awaitReference(NOW);
      expect(decide(tx({ kind: 'ROLLBACK', ...ref(pendingRefund) }), { reference: pendingRefund })).toEqual({ type: 'awaitReference' });
    });

    it.each<[string, Parameters<typeof tx>[0]]>([
      ['player', { playerId: 'p2' }],
      ['wallet', { walletId: 'w2' }],
      ['round', { roundId: 'r2' }],
      ['provider', { providerId: 'provider-b' }],
    ])('reference from another %s is REFERENCE_MISMATCH', (_label, change) => {
      const b = processed(bet('10.00', change));
      expect(decide(tx({ kind: 'REFUND', ...ref(b) }), { reference: b })).toMatchObject({ type: 'reject', code: 'REFERENCE_MISMATCH', referenceTransactionId: b.id });
    });

    it('reference in another currency is REFERENCE_MISMATCH', () => {
      const b = processed(bet('10.00', { currency: 'USD' }));
      expect(decide(tx({ kind: 'REFUND', ...ref(b) }), { reference: b })).toMatchObject({ type: 'reject', code: 'REFERENCE_MISMATCH' });
    });
  });
});
