import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import { PollingWorker } from '../../../shared/infrastructure/workers/polling-worker';
import { ResolvePendingReferencesUseCase } from '../application/resolve-pending-references.use-case';

@Injectable()
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly resolve: ResolvePendingReferencesUseCase,
    config: ConfigService<Env, true>,
  ) {
    super({
      name: 'PendingReferenceWorker',
      enabled: config.get('APP_ROLES', { infer: true }).includes('workers'),
      idleDelayMs: config.get('PENDING_REFERENCE_POLL_INTERVAL_MS', { infer: true }),
      errorDelayMs: 2000,
    });
  }

  protected async runOnce(): Promise<number> {
    return (await this.resolve.resolveDue()).examined;
  }
}
