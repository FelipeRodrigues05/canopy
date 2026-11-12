/**
 * Helpers over Postgres errors as MikroORM surfaces them (DriverException
 * copies the driver error's own properties, SQLSTATE included as `code`).
 */
interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
}

export const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
  adminShutdown: '57P01',
  cannotConnectNow: '57P03',
} as const;

export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as PgLikeError).code;
  return typeof code === 'string' ? code : undefined;
}

export function constraintName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as PgLikeError;
  const name = e.constraint ?? e.constraint_name;
  if (typeof name === 'string') return name;
  // Bun's SQL client and some pg versions only put the name in the message.
  const message = error instanceof Error ? error.message : '';
  return /constraint "([^"]+)"/.exec(message)?.[1];
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return sqlState(error) === SQLSTATE.uniqueViolation && (constraint === undefined || constraintName(error) === constraint);
}

/** The whole transaction can simply run again. */
export function isRetryableTransactionError(error: unknown): boolean {
  const state = sqlState(error);
  return state === SQLSTATE.serializationFailure || state === SQLSTATE.deadlockDetected;
}

/** The database is unreachable or refused us for a while: answer 503 / retry the message. */
export function isTransientDatabaseError(error: unknown): boolean {
  const state = sqlState(error);
  if (state && (state.startsWith('08') || state.startsWith('53') || state === SQLSTATE.lockNotAvailable || state === SQLSTATE.queryCanceled
    || state === SQLSTATE.adminShutdown || state === SQLSTATE.cannotConnectNow || isRetryableTransactionError(error))) {
    return true;
  }
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'ERR_POSTGRES_CONNECTION_CLOSED'].includes(code)) {
    return true;
  }
  const name = error instanceof Error ? error.name : '';
  return name === 'ConnectionException' || name === 'LockWaitTimeoutException' || name === 'DeadlockException';
}
