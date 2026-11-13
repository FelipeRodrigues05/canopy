import { ForbiddenException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '../application/provider-identity.port';

export type RequestWithPrincipal = { principal?: Principal };

/** With authentication disabled (local runs, most test suites), every caller is this one. */
export const ANONYMOUS_INTERNAL: Principal = { subject: 'anonymous', clientId: 'auth-disabled', providerId: null };

/** The authenticated caller of this request. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal ?? ANONYMOUS_INTERNAL;
});

/**
 * A provider may only act for itself: the providerId in the payload or path
 * must be the one in its token (README 2: "a identidade do provedor contida
 * na mensagem continua sujeita às mesmas validações").
 *
 * `allowInternal`: internal callers (no provider claim, e.g. backoffice) may
 * read any provider's data but never submit operations in a provider's name.
 */
export function assertActsFor(principal: Principal, providerId: string, options: { allowInternal: boolean }): void {
  if (principal === ANONYMOUS_INTERNAL) return;
  if (principal.providerId === null) {
    if (options.allowInternal) return;
    throw new ForbiddenException('Only provider clients can submit wager operations');
  }
  if (principal.providerId !== providerId) {
    throw new ForbiddenException(`Token of provider ${principal.providerId} cannot act for provider ${providerId}`);
  }
}
