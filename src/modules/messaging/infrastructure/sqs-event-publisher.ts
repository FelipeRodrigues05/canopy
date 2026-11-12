import { Injectable } from '@nestjs/common';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueues } from '../../../shared/infrastructure/sqs/sqs-queues';
import { EventPublisher, type PublishReport } from '../application/ports/event-publisher';
import type { OutboxMessage } from '../domain/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes to the wallet-events FIFO queue.
 *
 * - MessageGroupId = aggregateId: events of one wallet/transaction keep their
 *   order in the broker, while different aggregates flow in parallel.
 * - MessageDeduplicationId = eventId: a republish within SQS's 5-minute window
 *   is dropped by the broker. Past that window consumers still dedupe by
 *   eventId; the broker is an optimization, not the guarantee.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
  ) {
    super();
  }

  async publish(messages: OutboxMessage[]): Promise<PublishReport> {
    const report: PublishReport = { published: [], failed: [] };
    if (messages.length === 0) return report;

    let queueUrl: string;
    try {
      queueUrl = await this.queues.url('events');
    } catch (error: unknown) {
      return { published: [], failed: messages.map((m) => ({ id: m.id, error: describe(error) })) };
    }

    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const out = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m) => ({
              Id: m.id,
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: m.eventType },
                eventId: { DataType: 'String', StringValue: m.id },
              },
            })),
          }),
        );
        for (const ok of out.Successful ?? []) if (ok.Id) report.published.push(ok.Id);
        for (const ko of out.Failed ?? []) {
          if (ko.Id) report.failed.push({ id: ko.Id, error: `${ko.Code ?? 'error'}: ${ko.Message ?? ''}` });
        }
      } catch (error: unknown) {
        for (const m of chunk) report.failed.push({ id: m.id, error: describe(error) });
      }
    }
    return report;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
