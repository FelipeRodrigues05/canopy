import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet } from 'jose';
import type { Env } from '../../config/env.schema';
import { ProviderIdentityPort } from './application/provider-identity.port';
import { OidcProviderIdentity } from './infrastructure/oidc-provider-identity';
import { AuthGuard } from './presentation/auth.guard';
import { AuthSettings } from './presentation/auth.settings';

@Global()
@Module({
  providers: [
    {
      provide: AuthSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AuthSettings => ({ enabled: config.get('AUTH_ENABLED', { infer: true }) }),
    },
    {
      provide: ProviderIdentityPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ProviderIdentityPort => {
        const issuer = config.get('AUTH_ISSUER', { infer: true }) ?? 'http://auth.disabled';
        const jwksUrl = config.get('AUTH_JWKS_URL', { infer: true }) ?? `${issuer}/protocol/openid-connect/certs`;
        return new OidcProviderIdentity({
          issuer,
          audience: config.get('AUTH_AUDIENCE', { infer: true }),
          // Lazy: nothing is fetched until the first token arrives; keys are cached
          // and refetched when a token names an unknown key id (rotation).
          keys: createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 3000, cooldownDuration: 30_000 }),
        });
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ProviderIdentityPort, AuthSettings],
})
export class AuthModule {}
