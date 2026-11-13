import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { AppMetrics } from '../../../shared/application/metrics';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { WalletRepository } from '../../wallet/application/ports/wallet.repository';
import { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { WagerProcessor } from './wager-processor';

export interface ResolveReport {
  examined: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
}

export const PENDING_BATCH_SIZE = 50;

/**
 * Re-examines transactions parked as PENDING_REFERENCE (README 7.1). Each one
 * runs the same WagerProcessor as a fresh submission: reference found ->
 * applied or rejected by the same rules; still missing -> next attempt with
 * exponential backoff; attempts exhausted -> REJECTED REFERENCE_NOT_FOUND
 * with its event.
 *
 * One SQL transaction per item, locking in the same order as the submit path
 * (wallet row first, then the transaction row) so the two never deadlock. The
 * transaction row is taken with SKIP LOCKED: another worker on another
 * instance holding it means "not mine", not "wait".
 */
@Injectable()
export class ResolvePendingReferencesUseCase {
  private readonly logger = new Logger(ResolvePendingReferencesUseCase.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly metrics: AppMetrics,
  ) {}

  async resolveDue(limit = PENDING_BATCH_SIZE): Promise<ResolveReport> {
    const report: ResolveReport = { examined: 0, processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };
    const candidates = await this.uow.run(() => this.transactions.findDuePendingIds(limit, this.clock.now()));

    for (const id of candidates) {
      report.examined++;
      const status = await this.uow.run(async () => {
        const peek = await this.transactions.findById(id);
        if (!peek || peek.status !== 'PENDING_REFERENCE') return 'skipped';
        const wallet = await this.wallets.findByIdForUpdate(peek.walletId);
        const tx = await this.transactions.lockDuePending(id, this.clock.now());
        if (!wallet || !tx) return 'skipped';

        await this.processor.process(tx, wallet, { correlationId: `pending-reference:${tx.id}`, causationId: tx.id }, 'update');
        return { kind: tx.kind, status: tx.status };
      });
      const result =
        typeof status === 'string' ? status : status.status === 'PROCESSED' ? 'processed' : status.status === 'REJECTED' ? 'rejected' : 'rescheduled';
      report[result]++;
      this.metrics.pendingReferenceResolved(result);
      if (typeof status !== 'string' && result !== 'rescheduled') {
        this.metrics.transactionDecided({ kind: status.kind, status: status.status, source: 'pending_worker' });
      }
    }

    if (report.processed + report.rejected > 0) {
      this.logger.log({ msg: 'pending references resolved', ...report });
    }
    return report;
  }
}
