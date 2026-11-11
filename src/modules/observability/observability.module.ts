import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';

export const CORRELATION_HEADER = 'x-correlation-id';

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
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const incoming = req.headers[CORRELATION_HEADER];
            const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
            res.setHeader(CORRELATION_HEADER, id);
            return id;
          },
          customAttributeKeys: { reqId: 'correlationId' },
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
