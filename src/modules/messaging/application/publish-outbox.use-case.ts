import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { EventPublisher } from './ports/event-publisher';
import { OutboxRepository } from './ports/outbox.repository';

export interface PublishOutboxResult {
  claimed: number;
  published: string[];
  failed: number;
}

export const OUTBOX_BATCH_SIZE = 100;

/**
 * One publishing cycle: claim a batch of due events, send them, record the
 * result; all inside one short transaction.
 *
 * The send happens while the rows are locked on purpose: a concurrent
 * publisher skips them (SKIP LOCKED) instead of sending them a second time.
 * If the process dies after sending and before committing, the locks vanish
 * with the connection and the batch is sent again later: at-least-once, made
 * safe by the eventId every consumer deduplicates on. Events are only ever
 * read here after the business transaction that wrote them committed, so
 * nothing is published before its commit.
 */
@Injectable()
export class PublishOutboxUseCase {
  private readonly logger = new Logger(PublishOutboxUseCase.name);
  /** Observability hook (metrics). */
  static hook: ((result: PublishOutboxResult) => void) | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async publishPending(batchSize = OUTBOX_BATCH_SIZE): Promise<PublishOutboxResult> {
    const result = await this.uow.run(async () => {
      const due = await this.outbox.claimDue(batchSize, this.clock.now());
      if (due.length === 0) return { claimed: 0, published: [], failed: 0 };

      const report = await this.publisher.publish(due);
      const now = this.clock.now();
      await this.outbox.markPublished(report.published, now);

      const errors = new Map(report.failed.map((f) => [f.id, f.error]));
      for (const message of due) {
        const error = errors.get(message.id);
        if (error === undefined) continue;
        message.scheduleRetry(now, error);
        await this.outbox.saveRetry(message);
      }
      if (report.failed.length > 0) {
        this.logger.warn({ msg: 'outbox publish failures', failed: report.failed.length, sample: report.failed[0]?.error });
      }
      return { claimed: due.length, published: report.published, failed: report.failed.length };
    });
    PublishOutboxUseCase.hook?.(result);
    return result;
  }
}
