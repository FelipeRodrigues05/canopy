import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';
import { Correlation } from '../../shared/infrastructure/correlation';

/**
 * Financial values must never land in the logs in full (RNF06). Anything that
 * could carry an amount, a balance or a credential is censored here, wherever
 * it shows up in a log record.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.amount',
  '*.balance',
  '*.initialBalance',
  '*.balanceBefore',
  '*.balanceAfter',
  '*.*.amount',
  '*.*.balance',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          base: { service: 'canopy', pid: process.pid },
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
          // The correlation middleware runs first and sets req.id from X-Correlation-Id.
          genReqId: (req: IncomingMessage & { id?: unknown }) => (typeof req.id === 'string' ? req.id : randomUUID()),
          quietReqLogger: true,
          // Adds correlationId (and transactionId, walletId, messageId... once
          // assigned) to every line, HTTP or not.
          mixin: () => ({ ...Correlation.current() }),
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith('/health') === true || req.url === '/metrics',
          },
          serializers: {
            req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class ObservabilityModule {}
