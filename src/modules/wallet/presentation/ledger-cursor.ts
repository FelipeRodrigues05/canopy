import { InvalidPayloadError } from '../../../shared/application/application-error';

/**
 * Opaque cursor: base64url of {"s": <sequence>}. Clients must not build or
 * parse it; the encoding can change without breaking them. Sequences are
 * assigned under the wallet lock, so the order never depends on clocks (A4).
 */
export const LedgerCursor = {
  encode(beforeSequence: number): string {
    return Buffer.from(JSON.stringify({ s: beforeSequence })).toString('base64url');
  },

  decode(cursor: string | undefined): number | null {
    if (cursor === undefined || cursor === '') return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const s = (parsed as { s?: unknown }).s;
      if (typeof s === 'number' && Number.isSafeInteger(s) && s >= 1) return s;
    } catch {
      // fall through
    }
    throw new InvalidPayloadError('Invalid ledger cursor');
  },
};
