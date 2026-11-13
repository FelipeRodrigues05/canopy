import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../../../config/env.schema';
import { SqsQueues } from './sqs-queues';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const endpoint = config.get('AWS_ENDPOINT_URL', { infer: true });
        return new SQSClient({
          // Bounded calls: a publisher holds row locks while it sends.
          requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
          maxAttempts: 2,
          region: config.get('AWS_REGION', { infer: true }),
          ...(endpoint ? { endpoint } : {}),
          credentials: {
            accessKeyId: config.get('AWS_ACCESS_KEY_ID', { infer: true }),
            secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', { infer: true }),
          },
        });
      },
    },
    SqsQueues,
  ],
  exports: [SQSClient, SqsQueues],
})
export class SqsModule {}
