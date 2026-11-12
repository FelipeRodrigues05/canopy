import { Module } from '@nestjs/common';
import { MessagingPersistenceModule } from '../messaging/messaging-persistence.module';
import { WageringPersistenceModule } from '../wagering/wagering-persistence.module';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import { LedgerRepository } from './application/ports/ledger.repository';
import { WalletRepository } from './application/ports/wallet.repository';
import { MikroOrmLedgerRepository } from './infrastructure/mikro-orm-ledger.repository';
import { MikroOrmWalletRepository } from './infrastructure/mikro-orm-wallet.repository';
import { LedgerController } from './presentation/ledger.controller';
import { WalletController } from './presentation/wallet.controller';

@Module({
  imports: [WageringPersistenceModule, MessagingPersistenceModule],
  controllers: [WalletController, LedgerController],
  providers: [
    { provide: WalletRepository, useClass: MikroOrmWalletRepository },
    { provide: LedgerRepository, useClass: MikroOrmLedgerRepository },
    CreateWalletUseCase,
    GetWalletUseCase,
    ListLedgerUseCase,
  ],
  exports: [WalletRepository, LedgerRepository],
})
export class WalletModule {}
