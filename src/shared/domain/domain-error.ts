/**
 * Base class for errors raised by domain invariants. Pure: no HTTP status, no
 * framework. The presentation layer maps `code` to a transport response.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A value that can never be valid (malformed money, bad currency, ...). */
export class InvalidValueError extends DomainError {
  readonly code: string = 'INVALID_PAYLOAD';
}

/** A state transition the aggregate does not allow. Always a bug in the caller. */
export class InvariantViolationError extends DomainError {
  readonly code: string = 'INVARIANT_VIOLATION';
}
