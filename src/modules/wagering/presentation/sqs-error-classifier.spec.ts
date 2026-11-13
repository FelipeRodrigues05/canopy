import { describe, expect, it } from 'bun:test';
import { InvalidPayloadError, TransientInfrastructureError } from '../../../shared/application/application-error';
import { InvalidValueError } from '../../../shared/domain/domain-error';
import { IdempotencyConflictError, UnknownWalletError } from '../application/wagering.errors';
import { type FailureDisposition, classifyFailure, retryDelaySeconds } from './sqs-error-classifier';

describe('classifyFailure', () => {
  it.each<[string, unknown, FailureDisposition]>([
    ['invalid payload', new InvalidPayloadError('bad'), 'permanent'],
    ['invalid money in domain', new InvalidValueError('bad'), 'permanent'],
    ['idempotency conflict', new IdempotencyConflictError('x'), 'permanent'],
    ['unknown wallet', new UnknownWalletError('x'), 'business'],
    ['transient infra', new TransientInfrastructureError('x'), 'transient'],
    ['postgres connection refused', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'transient'],
    ['deadlock', Object.assign(new Error('x'), { code: '40P01' }), 'transient'],
    ['too many connections', Object.assign(new Error('x'), { code: '53300' }), 'transient'],
    ['unknown bug', new TypeError('oops'), 'transient'],
  ])('%s -> %s', (_label, error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });
});

describe('retryDelaySeconds', () => {
  it('grows exponentially and caps at 5 minutes', () => {
    expect([1, 2, 3, 4, 20].map(retryDelaySeconds)).toEqual([2, 4, 8, 16, 300]);
  });
});
