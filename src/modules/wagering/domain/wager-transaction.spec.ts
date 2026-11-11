import { describe, expect, it } from 'bun:test';
import { InvalidValueError, InvariantViolationError } from '../../../shared/domain/domain-error';
import { Money } from '../../../shared/domain/money';
import { NOW, tx } from './__fixtures__/wager.fixtures';
import { WagerTransaction } from './wager-transaction';

const later = new Date(NOW.getTime() + 1000);

describe('WagerTransaction', () => {
  describe('submit', () => {
    it('starts PENDING', () => {
      const t = tx();
      expect(t.status).toBe('PENDING');
      expect(t.isTerminal).toBe(false);
      expect(t.referenceAttempts).toBe(0);
    });

    it('refuses OPENING and unknown kinds (RF15)', () => {
      expect(() => tx({ kind: 'OPENING' })).toThrow(InvalidValueError);
      expect(() => tx({ kind: 'JACKPOT' })).toThrow(InvalidValueError);
    });

    it('REFUND and ROLLBACK need a reference', () => {
      expect(() => tx({ kind: 'REFUND' })).toThrow(InvalidValueError);
      expect(() => tx({ kind: 'ROLLBACK' })).toThrow(InvalidValueError);
      expect(tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'ext-bet' }).requiresReference).toBe(true);
    });

    it('cannot reference itself', () => {
      expect(() => tx({ kind: 'REFUND', externalTransactionId: 'x', referenceExternalTransactionId: 'x' })).toThrow(InvalidValueError);
    });

    it('WIN reference is optional', () => {
      expect(tx({ kind: 'WIN' }).requiresReference).toBe(false);
      expect(tx({ kind: 'WIN', referenceExternalTransactionId: 'ext-bet' }).requiresReference).toBe(true);
    });
  });

  it('opening is an internal credit with deterministic ids', () => {
    const t = WagerTransaction.opening({ id: 'o1', walletId: 'w1', playerId: 'p1', amount: Money.from('50', 'BRL'), payloadHash: 'h', now: NOW });
    expect(t.kind).toBe('OPENING');
    expect(t.providerId).toBe('canopy');
    expect(t.externalTransactionId).toBe('opening:w1');
  });

  describe('transitions', () => {
    it('PENDING -> PROCESSED', () => {
      const t = tx();
      t.markProcessed(later, 'ref-id');
      expect(t.status).toBe('PROCESSED');
      expect(t.processedAt).toEqual(later);
      expect(t.referenceTransactionId).toBe('ref-id');
    });

    it('PENDING -> REJECTED keeps the failure code', () => {
      const t = tx();
      t.reject('INSUFFICIENT_FUNDS', later);
      expect(t.status).toBe('REJECTED');
      expect(t.failureCode).toBe('INSUFFICIENT_FUNDS');
    });

    it('PENDING -> PENDING_REFERENCE -> attempts -> PROCESSED', () => {
      const t = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'missing' });
      t.awaitReference(later);
      expect(t.status).toBe('PENDING_REFERENCE');
      expect(t.nextRetryAt).toEqual(later);
      t.registerReferenceAttempt(new Date(later.getTime() + 2000));
      t.registerReferenceAttempt(new Date(later.getTime() + 4000));
      expect(t.referenceAttempts).toBe(2);
      t.markProcessed(later);
      expect(t.status).toBe('PROCESSED');
      expect(t.nextRetryAt).toBeNull();
    });

    it('PENDING_REFERENCE -> REJECTED when the worker gives up', () => {
      const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'missing' });
      t.awaitReference(later);
      t.reject('REFERENCE_NOT_FOUND', later);
      expect(t.failureCode).toBe('REFERENCE_NOT_FOUND');
    });

    it('FAILED records an infra failure code', () => {
      const t = tx();
      t.fail(later);
      expect(t.status).toBe('FAILED');
      expect(t.failureCode).toBe('INFRA_PERMANENT_FAILURE');
    });

    it.each(['PROCESSED', 'REJECTED', 'FAILED'] as const)('%s is terminal: every transition throws', (status) => {
      const t = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: 'r' });
      if (status === 'PROCESSED') t.markProcessed(later);
      if (status === 'REJECTED') t.reject('AMOUNT_MISMATCH', later);
      if (status === 'FAILED') t.fail(later);
      expect(t.isTerminal).toBe(true);
      expect(() => t.markProcessed(later)).toThrow(InvariantViolationError);
      expect(() => t.reject('INSUFFICIENT_FUNDS', later)).toThrow(InvariantViolationError);
      expect(() => t.fail(later)).toThrow(InvariantViolationError);
      expect(() => t.awaitReference(later)).toThrow(InvariantViolationError);
      expect(() => t.registerReferenceAttempt(later)).toThrow(InvariantViolationError);
    });

    it('awaitReference only from PENDING and only with a reference', () => {
      expect(() => tx().awaitReference(later)).toThrow(InvariantViolationError);
      const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'r' });
      t.awaitReference(later);
      expect(() => t.awaitReference(later)).toThrow(InvariantViolationError);
      expect(() => tx().registerReferenceAttempt(later)).toThrow(InvariantViolationError);
    });
  });

  it('records the first outcome only (replay returns what was said first, A5)', () => {
    const t = tx({ kind: 'REFUND', referenceExternalTransactionId: 'r' });
    const first = { status: 'PENDING_REFERENCE' as const, failureCode: null, balance: { amount: '100.00', currency: 'BRL' }, walletVersion: 1, decidedAt: NOW.toISOString() };
    t.recordOutcome(first);
    t.recordOutcome({ ...first, status: 'PROCESSED', balance: { amount: '110.00', currency: 'BRL' } });
    expect(t.outcome).toEqual(first);
  });
});
