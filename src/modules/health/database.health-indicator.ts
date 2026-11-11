import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/postgresql';

/**
 * Runs a real `SELECT 1` instead of asking the driver whether it thinks it is
 * connected: MikroORM connects lazily, and a stale pool can claim to be
 * connected while the server is gone.
 */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly orm: MikroORM,
  ) {}

  async isHealthy<const Key extends string>(key: Key, timeoutMs = 2000) {
    const indicator = this.indicators.check(key);
    try {
      await Promise.race([
        this.orm.em.getConnection().execute('select 1'),
        Bun.sleep(timeoutMs).then(() => Promise.reject(new Error(`timeout after ${timeoutMs} ms`))),
      ]);
      return indicator.up();
    } catch (error: unknown) {
      return indicator.down({ message: error instanceof Error ? error.message : 'unreachable' });
    }
  }
}
