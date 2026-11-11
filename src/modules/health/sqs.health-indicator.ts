import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueues } from '../../shared/infrastructure/sqs/sqs-queues';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
  ) {}

  async isHealthy<const Key extends string>(key: Key) {
    const indicator = this.indicators.check(key);
    try {
      const QueueUrl = await this.queues.url('wager');
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return indicator.up();
    } catch (error: unknown) {
      return indicator.down({ message: error instanceof Error ? error.message : 'unreachable' });
    }
  }
}
