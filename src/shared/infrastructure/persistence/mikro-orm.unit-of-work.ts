import { Injectable, Logger } from '@nestjs/common';
import { IsolationLevel, MikroORM } from '@mikro-orm/postgresql';
import { AppMetrics, type LockConflictType } from '../../application/metrics';
import { UnitOfWork } from '../../application/unit-of-work';
import { SQLSTATE, isRetryableTransactionError, sqlState } from './pg-errors';

const MAX_ATTEMPTS = 3;

const LOCK_CONFLICTS: Record<string, LockConflictType> = {
  [SQLSTATE.deadlockDetected]: 'deadlock',
  [SQLSTATE.serializationFailure]: 'serialization',
  [SQLSTATE.lockNotAvailable]: 'lock_timeout',
};

/**
 * READ COMMITTED + explicit row locks (SELECT ... FOR UPDATE on the wallet) is
 * the concurrency strategy; see ARCHITECTURE.md. Deadlocks and serialization
 * failures re-run the whole unit with jittered backoff, a bounded number of
 * times. `lock_timeout` keeps a stuck lock from hanging a request forever: it
 * surfaces as a transient error (503 / message retry).
 */
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  private readonly logger = new Logger(MikroOrmUnitOfWork.name);
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: AppMetrics,
  ) {
    super();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(
          async (em) => {
            await em.execute(`set local lock_timeout = '5s'`);
            return work();
          },
          { isolationLevel: IsolationLevel.READ_COMMITTED },
        );
      } catch (error: unknown) {
        const conflict = LOCK_CONFLICTS[sqlState(error) ?? ''];
        if (conflict) this.metrics.lockConflict(conflict);
        if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
        const reason = conflict ?? 'unknown';
        this.metrics.processingRetry(`db_${reason}`);
        this.logger.warn({ msg: 'transaction retry', attempt, reason });
        await Bun.sleep(10 * 2 ** attempt + Math.random() * 20);
      }
    }
  }
}
