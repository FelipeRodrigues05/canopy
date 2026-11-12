export type SubmissionSourceLabel = 'http' | 'sqs';
export type DuplicateSource = 'http' | 'sqs_inbox' | 'sqs_idempotency_key';
export type LockConflictType = 'deadlock' | 'serialization' | 'lock_timeout' | 'insert_race';
export type SubmissionOutcome = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'REPLAY' | 'CONFLICT' | 'INVALID' | 'BUSINESS_ERROR' | 'ERROR';

/**
 * What the application reports about itself, in domain words. Use cases call
 * these methods; the Prometheus adapter turns them into counters, gauges and
 * histograms. Keeps prom-client out of the application layer.
 */
export abstract class AppMetrics {
  /** A transaction reached a decision for the first time (not a replay). */
  abstract transactionDecided(labels: { kind: string; status: string; source: string }): void;
  /** End-to-end time of one submission, whatever happened. */
  abstract submissionCompleted(labels: { source: SubmissionSourceLabel; kind: string; outcome: SubmissionOutcome }, seconds: number): void;
  abstract duplicateDetected(source: DuplicateSource): void;
  abstract processingRetry(reason: string): void;
  abstract lockConflict(type: LockConflictType): void;
  abstract deadLettered(reason: string): void;
  abstract outboxPublished(published: number, failed: number): void;
  abstract reconciliationChecked(consistent: boolean): void;
  abstract pendingReferenceResolved(result: 'processed' | 'rejected' | 'rescheduled' | 'skipped'): void;
}

/** For unit tests and tools that do not care about metrics. */
export class NoopMetrics extends AppMetrics {
  transactionDecided(): void {}
  submissionCompleted(): void {}
  duplicateDetected(): void {}
  processingRetry(): void {}
  lockConflict(): void {}
  deadLettered(): void {}
  outboxPublished(): void {}
  reconciliationChecked(): void {}
  pendingReferenceResolved(): void {}
}
