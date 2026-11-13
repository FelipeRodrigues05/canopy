import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Correlation id assigned to this request by the correlation middleware. */
export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ id?: unknown }>();
  return typeof req.id === 'string' ? req.id : randomUUID();
});
