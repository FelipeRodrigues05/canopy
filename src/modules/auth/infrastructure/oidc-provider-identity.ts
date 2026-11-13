import { Injectable } from '@nestjs/common';
import { type JWTVerifyGetKey, errors as joseErrors, jwtVerify } from 'jose';
import { AuthenticationFailedError, type Principal, ProviderIdentityPort } from '../application/provider-identity.port';

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  /** Key source: remote JWKS in production, a local key set in tests. */
  keys: JWTVerifyGetKey;
  /** Claim that carries the provider id (a hardcoded-claim mapper per client in Keycloak). */
  providerClaim?: string;
}

const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'];

/**
 * Validates access tokens issued by an OIDC provider (Keycloak here):
 * signature against the provider's published keys (JWKS, cached and rotated
 * by jose), asymmetric algorithms only (no "none", no HS256 with a guessed
 * secret), issuer, audience, expiry and not-before with a small clock skew.
 */
@Injectable()
export class OidcProviderIdentity extends ProviderIdentityPort {
  constructor(private readonly options: OidcVerifierOptions) {
    super();
  }

  async authenticate(bearerToken: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(bearerToken, this.options.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: 5,
        requiredClaims: ['exp', 'sub'],
      });
      const providerId = payload[this.options.providerClaim ?? 'provider_id'];
      const clientId = payload.azp ?? payload.client_id;
      return {
        subject: String(payload.sub),
        clientId: typeof clientId === 'string' ? clientId : 'unknown',
        providerId: typeof providerId === 'string' && providerId.length > 0 ? providerId : null,
      };
    } catch (error: unknown) {
      if (error instanceof joseErrors.JOSEError) {
        throw new AuthenticationFailedError(error.code);
      }
      throw error; // e.g. JWKS endpoint unreachable: not the caller's fault
    }
  }
}
