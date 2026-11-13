import { describe, expect, it } from 'bun:test';
import { canonicalHash, canonicalJson } from '../../../shared/infrastructure/canonical-hash';
import { wagerFingerprint, type WagerFingerprintFields } from './wager-fingerprint';

const bet: WagerFingerprintFields = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

describe('canonical hash', () => {
  it('ignores key order, recursively', () => {
    expect(canonicalJson({ b: 1 === 1, a: { d: 'x', c: null } })).toBe('{"a":{"c":null,"d":"x"},"b":true}');
    expect(canonicalHash({ a: '1', b: { y: '2', x: '3' } })).toBe(canonicalHash({ b: { x: '3', y: '2' }, a: '1' }));
  });

  it('drops undefined and refuses numbers', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
    expect(() => canonicalJson({ amount: 10 })).toThrow(TypeError);
  });

  it('is a sha-256 hex digest', () => {
    expect(canonicalHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('wagerFingerprint (idempotency key vs payload)', () => {
  it('same request in different shapes has the same fingerprint', () => {
    const reordered = Object.fromEntries(Object.entries(bet).reverse()) as unknown as WagerFingerprintFields;
    expect(wagerFingerprint(reordered)).toBe(wagerFingerprint(bet));
    expect(wagerFingerprint({ ...bet, money: { currency: 'BRL', amount: '10' } })).toBe(wagerFingerprint(bet));
    expect(wagerFingerprint({ ...bet, referenceExternalTransactionId: null })).toBe(wagerFingerprint(bet));
  });

  it.each<[string, Partial<WagerFingerprintFields>]>([
    ['amount', { money: { amount: '10.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '10.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['wallet', { walletId: 'w2' }],
    ['player', { playerId: 'p2' }],
    ['round', { roundId: 'r2' }],
    ['game', { gameId: 'g2' }],
    ['external id', { externalTransactionId: 'ext-2' }],
    ['reference', { referenceExternalTransactionId: 'ext-0' }],
  ])('a different %s is a different payload (409 on the same key)', (_label, change) => {
    expect(wagerFingerprint({ ...bet, ...change })).not.toBe(wagerFingerprint(bet));
  });
});
