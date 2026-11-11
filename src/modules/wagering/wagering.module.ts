import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { MessagingPersistenceModule } from '../messaging/messaging-persistence.module';
import { WalletModule } from '../wallet/wallet.module';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { WagerProcessor } from './application/wager-processor';
import { WageringConfig } from './application/wagering.config';
import { WageringPersistenceModule } from './wagering-persistence.module';
import { WageringController } from './presentation/wagering.controller';

@Module({
  imports: [WalletModule, WageringPersistenceModule, MessagingPersistenceModule],
  controllers: [WageringController],
  providers: [
    {
      provide: WageringConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): WageringConfig => ({
        pendingReferenceMaxAttempts: config.get('PENDING_REFERENCE_MAX_ATTEMPTS', { infer: true }),
        pendingReferenceBaseDelayMs: config.get('PENDING_REFERENCE_BASE_DELAY_MS', { infer: true }),
        pendingReferenceMaxDelayMs: config.get('PENDING_REFERENCE_MAX_DELAY_MS', { infer: true }),
      }),
    },
    WagerProcessor,
    SubmitWagerTransactionUseCase,
  ],
  exports: [SubmitWagerTransactionUseCase, WagerProcessor, WageringConfig],
})
export class WageringModule {}
