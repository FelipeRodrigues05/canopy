import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../../../config/env.schema';

export type QueueName = 'wager' | 'wagerDlq' | 'events';

/**
 * Resolves queue URLs by name (GetQueueUrl) and caches them. Resolving instead
 * of building the URL by hand keeps the code identical for LocalStack and AWS.
 */
@Injectable()
export class SqsQueues {
  private readonly names: Record<QueueName, string>;
  private readonly urls = new Map<QueueName, Promise<string>>();

  constructor(
    private readonly sqs: SQSClient,
    config: ConfigService<Env, true>,
  ) {
    this.names = {
      wager: config.get('SQS_WAGER_QUEUE', { infer: true }),
      wagerDlq: config.get('SQS_WAGER_DLQ', { infer: true }),
      events: config.get('SQS_EVENTS_QUEUE', { infer: true }),
    };
  }

  url(queue: QueueName): Promise<string> {
    let cached = this.urls.get(queue);
    if (!cached) {
      cached = this.resolve(queue);
      this.urls.set(queue, cached);
      // A failed lookup must not be cached forever (SQS may just be starting).
      cached.catch(() => this.urls.delete(queue));
    }
    return cached;
  }

  private async resolve(queue: QueueName): Promise<string> {
    const out = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.names[queue] }));
    if (!out.QueueUrl) throw new Error(`Queue ${this.names[queue]} has no URL`);
    return out.QueueUrl;
  }
}
