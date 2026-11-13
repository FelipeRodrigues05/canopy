import { describe, expect, it } from 'bun:test';
import { InvalidPayloadError } from '../../../shared/application/application-error';
import { LedgerCursor } from './ledger-cursor';

describe('LedgerCursor', () => {
  it('round-trips and is opaque url-safe text', () => {
    const cursor = LedgerCursor.encode(42);
    expect(cursor).toMatch(/^[\w-]+$/);
    expect(LedgerCursor.decode(cursor)).toBe(42);
  });

  it('absent cursor means the first page', () => {
    expect(LedgerCursor.decode(undefined)).toBeNull();
    expect(LedgerCursor.decode('')).toBeNull();
  });

  it.each(['garbage!', Buffer.from('{"s":0}').toString('base64url'), Buffer.from('{"s":"1"}').toString('base64url'), Buffer.from('[]').toString('base64url')])(
    'rejects %p',
    (cursor) => {
      expect(() => LedgerCursor.decode(cursor)).toThrow(InvalidPayloadError);
    },
  );
});
