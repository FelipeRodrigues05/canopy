import { describe, expect, it } from 'bun:test';
import { ForbiddenException } from '@nestjs/common';
import { ANONYMOUS_INTERNAL, assertActsFor } from './principal';

const providerA = { subject: 's', clientId: 'provider-a', providerId: 'provider-a' };
const backoffice = { subject: 's', clientId: 'canopy-backoffice', providerId: null };

describe('assertActsFor', () => {
  it('a provider acts for itself only', () => {
    expect(() => assertActsFor(providerA, 'provider-a', { allowInternal: false })).not.toThrow();
    expect(() => assertActsFor(providerA, 'provider-b', { allowInternal: true })).toThrow(ForbiddenException);
  });

  it('internal callers may read but never submit in a provider name', () => {
    expect(() => assertActsFor(backoffice, 'provider-a', { allowInternal: true })).not.toThrow();
    expect(() => assertActsFor(backoffice, 'provider-a', { allowInternal: false })).toThrow(ForbiddenException);
  });

  it('auth disabled: everything allowed', () => {
    expect(() => assertActsFor(ANONYMOUS_INTERNAL, 'provider-a', { allowInternal: false })).not.toThrow();
  });
});
