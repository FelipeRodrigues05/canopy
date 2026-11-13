import { Module } from '@nestjs/common';
import { WagerTransactionRepository } from './application/ports/wager-transaction.repository';
import { MikroOrmWagerTransactionRepository } from './infrastructure/mikro-orm-wager-transaction.repository';

/** Repository only, so WalletModule can write the OPENING transaction without a module cycle. */
@Module({
  providers: [{ provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository }],
  exports: [WagerTransactionRepository],
})
export class WageringPersistenceModule {}
