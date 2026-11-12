import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { uuidSchema } from '../../../shared/presentation/schemas';
import { type ReconciliationReport, ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';

@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcile: ReconcileWalletUseCase) {}

  /** 200 with `consistent: true|false`: a divergence is a finding, not an HTTP error. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  run(@Param('walletId', { schema: uuidSchema }) walletId: string): Promise<ReconciliationReport> {
    return this.reconcile.execute(walletId);
  }
}
