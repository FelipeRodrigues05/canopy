import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

interface CorrelationStore {
  correlationId: string;
  [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/**
 * Correlation id carried across async calls, for logs only: use cases receive
 * it explicitly in their commands. HTTP requests take it from the
 * X-Correlation-Id header (or get a new one); consumers and workers open a
 * scope per message / per batch.
 */
export const Correlation = {
  current(): CorrelationStore | undefined {
    return storage.getStore();
  },

  id(): string | undefined {
    return storage.getStore()?.correlationId;
  },

  run<T>(fields: CorrelationStore, fn: () => T): T {
    return storage.run({ ...fields }, fn);
  },

  /** Adds fields (transactionId, walletId, ...) to every later log line of this scope. */
  assign(fields: Record<string, string | undefined>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },

  middleware: (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers[CORRELATION_HEADER];
    const id = typeof header === 'string' && /^[\w.:-]{1,128}$/.test(header) ? header : randomUUID();
    (req as Request & { id: string }).id = id;
    res.setHeader(CORRELATION_HEADER, id);
    storage.run({ correlationId: id }, next);
  },
};
