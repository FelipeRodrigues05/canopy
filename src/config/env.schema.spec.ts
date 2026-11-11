import { describe, expect, it } from 'bun:test';
import { validateEnv } from './env.schema';

const base = {
  DATABASE_URL: 'postgres://app:app@localhost:5432/canopy',
  MIGRATOR_DATABASE_URL: 'postgres://m:m@localhost:5432/canopy',
};

describe('validateEnv', () => {
  it('applies defaults and parses roles', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.APP_ROLES).toEqual(['api', 'consumer', 'workers']);
  });

  it('accepts a subset of roles', () => {
    expect(validateEnv({ ...base, APP_ROLES: 'consumer, workers' }).APP_ROLES).toEqual(['consumer', 'workers']);
  });

  it('fails fast on missing or invalid variables', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, APP_ROLES: 'api,bogus' })).toThrow(/APP_ROLES/);
  });
});
