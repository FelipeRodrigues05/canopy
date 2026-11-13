import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import { PollingWorker } from '../../../shared/infrastructure/workers/polling-worker';
import { PublishOutboxUseCase } from '../application/publish-outbox.use-case';

/** Runs on every instance with the `workers` role; SKIP LOCKED lets them share the outbox. */
@Injectable()
export class OutboxPublisherWorker extends PollingWorker {
  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    config: ConfigService<Env, true>,
  ) {
    super({
      name: 'OutboxPublisherWorker',
      enabled: config.get('APP_ROLES', { infer: true }).includes('workers'),
      idleDelayMs: config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }),
      errorDelayMs: 1000,
    });
  }

  protected async runOnce(): Promise<number> {
    const result = await this.publishOutbox.publishPending();
    return result.claimed;
  }
}
