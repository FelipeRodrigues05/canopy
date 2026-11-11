export type ErrorCategory = 'VALIDATION' | 'CONFLICT' | 'BUSINESS' | 'NOT_FOUND' | 'INFRA';

/**
 * Error a use case raises on purpose. `code` is part of the public contract;
 * `category` and `retryable` tell the transport how to answer.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;
  readonly retryable: boolean = false;

  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Database or broker unavailable, lock timeout, retries exhausted. Safe to retry. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';
  readonly category = 'INFRA' as const;
  override readonly retryable = true;
}

/** Malformed request: missing fields, invalid money, OPENING submitted, missing Idempotency-Key. */
export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
  readonly category = 'VALIDATION' as const;
}
