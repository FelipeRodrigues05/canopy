/**
 * Runs work inside one database transaction. Every repository call made while
 * `work` runs joins that transaction; it commits when `work` resolves and rolls
 * back when it throws. Implementations retry the whole unit on serialization
 * failures and deadlocks, so `work` must not have side effects outside the
 * database (no HTTP calls, no publishing).
 */
export abstract class UnitOfWork {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}
