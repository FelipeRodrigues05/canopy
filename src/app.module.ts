import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { validateEnv, type Env } from './config/env.schema';
import { buildOrmConfig } from './shared/infrastructure/mikro-orm.config';
import { SqsModule } from './shared/infrastructure/sqs/sqs.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { HealthModule } from './modules/health/health.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { SharedModule } from './shared/shared.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildOrmConfig({
          clientUrl: config.get('DATABASE_URL', { infer: true }),
          poolMax: config.get('DATABASE_POOL_MAX', { infer: true }),
        }),
    }),
    SharedModule,
    SqsModule,
    ObservabilityModule,
    HealthModule,
    WalletModule,
    WageringModule,
    MessagingModule,
  ],
})
export class AppModule {}
