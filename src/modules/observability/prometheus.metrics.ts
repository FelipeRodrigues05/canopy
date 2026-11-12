import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  AppMetrics,
  type DuplicateSource,
  type LockConflictType,
  type SubmissionOutcome,
  type SubmissionSourceLabel,
} from '../../shared/application/metrics';

/**
 * Prometheus adapter. One Registry per app instance (tests create several
 * apps in one process, so the global default registry is avoided).
 */
@Injectable()
export class PrometheusMetrics extends AppMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transactions by final decision (first decision only; replays excluded)',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end submission time (validation, transaction, commit)',
    labelNames: ['source', 'kind', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'idempotent_duplicates_total',
    help: 'Duplicates detected and answered without new effects',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'processing_retries_total',
    help: 'Retries: database transaction re-runs and SQS messages left for redelivery',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Deadlocks, serialization failures, lock timeouts and lost insert races',
    labelNames: ['type'],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages this consumer moved to the DLQ (broker redrives are counted by SQS)',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events sent to the broker',
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox events whose publication failed and was rescheduled',
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'reconciliations_total',
    help: 'Wallet reconciliations run',
    labelNames: ['consistent'],
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliations where stored balance and ledger disagree',
    registers: [this.registry],
  });
  private readonly pendingResolutions = new Counter({
    name: 'pending_reference_resolutions_total',
    help: 'Pending-reference worker outcomes',
    labelNames: ['result'],
    registers: [this.registry],
  });

  constructor() {
    super();
    collectDefaultMetrics({ register: this.registry });
  }

  transactionDecided(labels: { kind: string; status: string; source: string }): void {
    this.transactions.inc(labels);
  }
  submissionCompleted(labels: { source: SubmissionSourceLabel; kind: string; outcome: SubmissionOutcome }, seconds: number): void {
    this.duration.observe(labels, seconds);
  }
  duplicateDetected(source: DuplicateSource): void {
    this.duplicates.inc({ source });
  }
  processingRetry(reason: string): void {
    this.retries.inc({ reason });
  }
  lockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }
  deadLettered(reason: string): void {
    this.dlq.inc({ reason });
  }
  outboxPublished(published: number, failed: number): void {
    if (published > 0) this.outboxPublishedTotal.inc(published);
    if (failed > 0) this.outboxFailures.inc(failed);
  }
  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ consistent: String(consistent) });
    if (!consistent) this.reconciliationMismatches.inc();
  }
  pendingReferenceResolved(result: 'processed' | 'rejected' | 'rescheduled' | 'skipped'): void {
    this.pendingResolutions.inc({ result });
  }
}
