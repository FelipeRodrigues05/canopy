import { Injectable, Logger } from '@nestjs/common';
import { IsolationLevel, MikroORM } from '@mikro-orm/postgresql';
import { UnitOfWork } from '../../application/unit-of-work';
import { isRetryableTransactionError } from './pg-errors';

const MAX_ATTEMPTS = 3;

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
  static onRetry: ((reason: string) => void) | undefined;

  constructor(private readonly orm: MikroORM) {
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
        if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
        const reason = (error as { code?: string }).code ?? 'unknown';
        MikroOrmUnitOfWork.onRetry?.(reason);
        this.logger.warn({ msg: 'transaction retry', attempt, reason });
        await Bun.sleep(10 * 2 ** attempt + Math.random() * 20);
      }
    }
  }
}
