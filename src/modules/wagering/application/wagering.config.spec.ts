import { describe, expect, it } from 'bun:test';
import { pendingReferenceDelayMs } from './wagering.config';

describe('pendingReferenceDelayMs', () => {
  const production = { pendingReferenceMaxAttempts: 10, pendingReferenceBaseDelayMs: 1000, pendingReferenceMaxDelayMs: 300_000 };

  it('doubles from the base and caps at 5 minutes', () => {
    expect([0, 1, 2, 3, 8, 9, 20].map((n) => pendingReferenceDelayMs(production, n))).toEqual([
      1000, 2000, 4000, 8000, 256_000, 300_000, 300_000,
    ]);
  });

  it('with 10 attempts the reference gets about 13 minutes to arrive', () => {
    const total = Array.from({ length: 10 }, (_, n) => pendingReferenceDelayMs(production, n)).reduce((a, b) => a + b, 0);
    expect(total).toBe(811_000); // 1+2+4+...+256 s + 300 s
  });
});
