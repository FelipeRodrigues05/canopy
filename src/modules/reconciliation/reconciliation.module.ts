import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { ReconciliationController } from './presentation/reconciliation.controller';

@Module({
  imports: [WalletModule],
  controllers: [ReconciliationController],
  providers: [ReconcileWalletUseCase],
  exports: [ReconcileWalletUseCase],
})
export class ReconciliationModule {}
