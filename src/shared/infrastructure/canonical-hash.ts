import { createHash } from 'node:crypto';

type Json = string | boolean | null | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace,
 * `undefined` dropped. Two payloads that differ only in key order or in
 * absent-vs-undefined fields serialize identically.
 *
 * Numbers are refused on purpose: every business field is a string (money
 * included), and a number here would mean float formatting leaks into the
 * idempotency check.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** SHA-256 hex of the canonical JSON. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalize(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item)));
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = normalize(child);
    }
    return out;
  }
  throw new TypeError(`canonicalJson does not accept ${typeof value}`);
}
