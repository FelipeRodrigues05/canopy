import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Request, Response } from 'express';
import { ApplicationError, type ErrorCategory, InvalidPayloadError } from '../application/application-error';
import { InvalidValueError } from '../domain/domain-error';
import { isTransientDatabaseError } from '../infrastructure/persistence/pg-errors';

export interface ErrorBody {
  error: {
    code: string;
    category: ErrorCategory | 'INTERNAL' | 'AUTH';
    retryable: boolean;
    message: string;
    correlationId?: string;
    [key: string]: unknown;
  };
}

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  BUSINESS: HttpStatus.UNPROCESSABLE_ENTITY,
  INFRA: HttpStatus.SERVICE_UNAVAILABLE,
};

/** Turns schema validation issues into the INVALID_PAYLOAD error. */
export function schemaIssuesToError(issues: readonly StandardSchemaV1.Issue[]): InvalidPayloadError {
  return new InvalidPayloadError('Request payload is invalid', {
    issues: issues.map((i) => ({
      path: (i.path ?? []).map((p) => (typeof p === 'object' ? p.key : p)).join('.'),
      message: i.message,
    })),
  });
}

/**
 * One error shape for every endpoint, and one status per situation, so a
 * provider can decide to retry, fix the payload or give up from the status and
 * `code` alone (README 9):
 *
 *   400 invalid payload   409 conflict (idempotency, duplicate wallet)
 *   404 not found         422 business rejection
 *   503 transient (retry, with Retry-After)   500 unexpected
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const correlationId = typeof req.id === 'string' ? req.id : undefined;

    const { status, body } = this.describe(exception);
    if (correlationId) body.error.correlationId = correlationId;
    if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '1');

    if (status >= 500) {
      this.logger.error({ msg: 'request failed', status, code: body.error.code, err: exception });
    }
    res.status(status).json(body);
  }

  private describe(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApplicationError) {
      return {
        status: STATUS_BY_CATEGORY[exception.category],
        body: {
          error: {
            ...exception.details,
            code: exception.code,
            category: exception.category,
            retryable: exception.retryable,
            message: exception.message,
          },
        },
      };
    }
    if (exception instanceof InvalidValueError) {
      return error(HttpStatus.BAD_REQUEST, 'INVALID_PAYLOAD', 'VALIDATION', false, exception.message);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const [code, category] = HTTP_CODES[status] ?? ['HTTP_ERROR', 'INTERNAL'];
      return error(status, code, category, status >= 500, exception.message);
    }
    if (isTransientDatabaseError(exception)) {
      return error(HttpStatus.SERVICE_UNAVAILABLE, 'TRANSIENT_FAILURE', 'INFRA', true, 'Temporarily unavailable, retry');
    }
    // Anything else, a DomainError invariant included, is a bug, not a rejection.
    return error(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'INTERNAL', true, 'Unexpected error');
  }
}

const HTTP_CODES: Record<number, [string, ErrorBody['error']['category']]> = {
  400: ['INVALID_PAYLOAD', 'VALIDATION'],
  401: ['UNAUTHENTICATED', 'AUTH'],
  403: ['FORBIDDEN', 'AUTH'],
  404: ['NOT_FOUND', 'NOT_FOUND'],
  405: ['METHOD_NOT_ALLOWED', 'VALIDATION'],
  413: ['PAYLOAD_TOO_LARGE', 'VALIDATION'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'VALIDATION'],
};

function error(
  status: number,
  code: string,
  category: ErrorBody['error']['category'],
  retryable: boolean,
  message: string,
): { status: number; body: ErrorBody } {
  return { status, body: { error: { code, category, retryable, message } } };
}
