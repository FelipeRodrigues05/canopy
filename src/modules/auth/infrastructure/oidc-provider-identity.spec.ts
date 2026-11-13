import { beforeAll, describe, expect, it } from 'bun:test';
import { type JWTPayload, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { AuthenticationFailedError } from '../application/provider-identity.port';
import { OidcProviderIdentity } from './oidc-provider-identity';

const ISSUER = 'http://idp.test/realms/wagering';
const AUDIENCE = 'canopy-api';

describe('OidcProviderIdentity', () => {
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;
  let identity: OidcProviderIdentity;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    identity = new OidcProviderIdentity({ issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) });
  });

  function sign(claims: JWTPayload = {}, opts: { key?: CryptoKey; exp?: string | number; iss?: string; aud?: string } = {}) {
    return new SignJWT({ azp: 'provider-a', provider_id: 'provider-a', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('service-account-provider-a')
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(opts.key ?? privateKey);
  }

  it('accepts a valid token and reads the provider claim', async () => {
    expect(await identity.authenticate(await sign())).toEqual({
      subject: 'service-account-provider-a',
      clientId: 'provider-a',
      providerId: 'provider-a',
    });
  });

  it('a token without provider claim is an internal caller', async () => {
    const principal = await identity.authenticate(await sign({ provider_id: undefined, azp: 'canopy-backoffice' }));
    expect(principal).toMatchObject({ clientId: 'canopy-backoffice', providerId: null });
  });

  it.each<[string, () => Promise<string>]>([
    ['expired', () => sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['wrong issuer', () => sign({}, { iss: 'http://evil.test/realms/wagering' })],
    ['wrong audience', () => sign({}, { aud: 'another-api' })],
    ['signed by another key', () => sign({}, { key: otherKey })],
    ['garbage', async () => 'not.a.jwt'],
  ])('rejects %s', async (_label, token) => {
    expect(identity.authenticate(await token())).rejects.toThrow(AuthenticationFailedError);
  });

  it('rejects unsigned (alg: none) and symmetric (HS256) tokens', async () => {
    const header = (alg: string) => Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'x', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60, provider_id: 'provider-b' }),
    ).toString('base64url');
    expect(identity.authenticate(`${header('none')}.${body}.`)).rejects.toThrow(AuthenticationFailedError);
    const hs = await new SignJWT({ provider_id: 'provider-b' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('x').setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-guessed-shared-secret-of-enough-length'));
    expect(identity.authenticate(hs)).rejects.toThrow(AuthenticationFailedError);
  });
});
