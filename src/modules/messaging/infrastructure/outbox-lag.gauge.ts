import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Gauge, Registry } from 'prom-client';
import { Clock } from '../../../shared/application/clock';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { OutboxRepository } from '../application/ports/outbox.repository';

/**
 * outbox_lag_seconds: age of the oldest unpublished event, read from the
 * database on every scrape. It is the honest measure of "how far behind are
 * the publishers", whichever instance scrapes it.
 */
@Injectable()
export class OutboxLagGauge implements OnModuleInit {
  constructor(
    private readonly registry: Registry,
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    const { uow, outbox, clock } = this;
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age in seconds of the oldest event not yet published (0 = nothing pending)',
      registers: [this.registry],
      async collect() {
        try {
          this.set(await uow.run(() => outbox.oldestPendingAgeSeconds(clock.now())));
        } catch {
          // database down: leave the last value; readiness reports the outage
        }
      },
    });
  }
}
