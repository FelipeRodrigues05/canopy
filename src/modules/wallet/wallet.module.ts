import { Module } from '@nestjs/common';
import { MessagingPersistenceModule } from '../messaging/messaging-persistence.module';
import { WageringPersistenceModule } from '../wagering/wagering-persistence.module';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { LedgerRepository } from './application/ports/ledger.repository';
import { WalletRepository } from './application/ports/wallet.repository';
import { MikroOrmLedgerRepository } from './infrastructure/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from './infrastructure/mikro-orm-wallet.repository';
import { WalletController } from './presentation/wallet.controller';

@Module({
  imports: [WageringPersistenceModule, MessagingPersistenceModule],
  controllers: [WalletController],
  providers: [
    { provide: WalletRepository, useClass: MikroOrmWalletRepository },
    { provide: LedgerRepository, useClass: MikroOrmLedgerRepository },
    CreateWalletUseCase,
    GetWalletUseCase,
  ],
  exports: [WalletRepository, LedgerRepository],
})
export class WalletModule {}
