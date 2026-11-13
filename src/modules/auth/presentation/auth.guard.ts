import { type CanActivate, type ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TransientInfrastructureError } from '../../../shared/application/application-error';
import { AuthenticationFailedError, ProviderIdentityPort } from '../application/provider-identity.port';
import { AuthSettings } from './auth.settings';
import { IS_PUBLIC } from './public.decorator';
import type { RequestWithPrincipal } from './principal';

/**
 * Global guard (APP_GUARD): every HTTP route requires a valid bearer token
 * unless marked @Public(). Only HTTP is guarded: the SQS consumer is an
 * internal, trusted channel (README 2).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly identity: ProviderIdentityPort,
    private readonly settings: AuthSettings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' || !this.settings.enabled) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & RequestWithPrincipal>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Bearer token required');
    }
    try {
      req.principal = await this.identity.authenticate(token);
      return true;
    } catch (error: unknown) {
      if (error instanceof AuthenticationFailedError) {
        throw new UnauthorizedException(`Invalid token (${error.message})`);
      }
      // The IdP's keys could not be fetched: our problem, retryable.
      this.logger.error({ msg: 'token verification unavailable', err: error });
      throw new TransientInfrastructureError('Authentication temporarily unavailable');
    }
  }
}
