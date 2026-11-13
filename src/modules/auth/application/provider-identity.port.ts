/** Who is calling, as established by the identity provider. */
export interface Principal {
  /** Token subject (the client's service account in Keycloak). */
  subject: string;
  /** OAuth client that obtained the token. */
  clientId: string;
  /** Provider this caller acts for; null for internal callers (backoffice). */
  providerId: string | null;
}

/** Credentials missing, malformed, expired, or not issued for us. */
export class AuthenticationFailedError extends Error {}

/**
 * Extension point for authentication (README 2). The HTTP guard only knows
 * this port; Keycloak is one adapter. Another IdP (Zitadel, Auth0, Cognito),
 * mTLS or API keys would be another adapter, with no change elsewhere.
 */
export abstract class ProviderIdentityPort {
  /** Verifies a bearer token and returns the caller. Throws AuthenticationFailedError. */
  abstract authenticate(bearerToken: string): Promise<Principal>;
}
