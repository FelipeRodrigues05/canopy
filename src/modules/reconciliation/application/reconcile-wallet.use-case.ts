import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { LedgerRepository } from '../../wallet/application/ports/ledger.repository';
import { WalletRepository } from '../../wallet/application/ports/wallet.repository';
import { WalletNotFoundError } from '../../wallet/application/wallet.errors';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastEntrySequence: number | null;
  lastEntryBalanceAfter: MoneyProps | null;
  /** Human-readable reasons when not consistent. */
  findings: string[];
  checkedAt: string;
}

/**
 * RF12. Rebuilds the balance from the ledger (sum of credits minus debits)
 * and compares it with the stored balance. Also checks that the latest entry
 * describes the stored state (balance_after and sequence = version).
 *
 * A divergence is logged, counted and reported; it is never corrected here.
 * Fixing money silently would hide the bug that caused it.
 *
 * Reads under FOR SHARE on the wallet: no balance change of this wallet can
 * commit mid-check, so stored balance and ledger come from the same moment.
 */
@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);
  /** Observability hook (metrics). */
  static hook: ((report: ReconciliationReport) => void) | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(async () => {
      const wallet = await this.wallets.findByIdForShare(walletId);
      if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`, { walletId });
      const summary = await this.ledger.summarize(walletId);

      const currency = wallet.currency;
      const calculated = Money.from(summary.credits, currency).subtract(Money.from(summary.debits, currency));
      const difference = wallet.balance.subtract(calculated);
      const lastBalanceAfter = summary.lastBalanceAfter === null ? null : Money.from(summary.lastBalanceAfter, currency);

      const findings: string[] = [];
      if (!difference.isZero()) findings.push('stored balance differs from the ledger sum');
      if (lastBalanceAfter && !lastBalanceAfter.equals(wallet.balance)) {
        findings.push('stored balance differs from the latest entry balance_after');
      }
      if (summary.lastSequence !== null && summary.lastSequence !== wallet.version) {
        findings.push('wallet version differs from the latest entry sequence');
      }
      if (summary.lastSequence === null && wallet.version !== 1) {
        findings.push('wallet moved (version > 1) but has no ledger entries');
      }

      return {
        walletId,
        storedBalance: wallet.balance.toProps(),
        calculatedBalance: calculated.toProps(),
        difference: difference.toProps(),
        consistent: findings.length === 0,
        checkedEntries: summary.entries,
        walletVersion: wallet.version,
        lastEntrySequence: summary.lastSequence,
        lastEntryBalanceAfter: lastBalanceAfter?.toProps() ?? null,
        findings,
        checkedAt: this.clock.now().toISOString(),
      } satisfies ReconciliationReport;
    });

    if (!report.consistent) {
      // Logged without amounts in clear: the redaction covers balance/amount keys.
      this.logger.warn({ msg: 'reconciliation mismatch', walletId, findings: report.findings, difference: report.difference });
    }
    ReconcileWalletUseCase.hook?.(report);
    return report;
  }
}
