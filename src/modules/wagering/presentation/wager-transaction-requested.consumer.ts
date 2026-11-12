import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Env } from '../../../config/env.schema';
import { canonicalHash } from '../../../shared/infrastructure/canonical-hash';
import { Correlation } from '../../../shared/infrastructure/correlation';
import { SqsQueues } from '../../../shared/infrastructure/sqs/sqs-queues';
import { PollingWorker } from '../../../shared/infrastructure/workers/polling-worker';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { classifyFailure, retryDelaySeconds } from './sqs-error-classifier';
import { type WagerTransactionRequested, wagerTransactionRequestedSchema } from './wagering.schemas';

export type ConsumerEvent = 'acked' | 'duplicate' | 'retry' | 'dlq';

/**
 * Consumes wager-transactions.fifo with the same use case as HTTP (README 10).
 *
 * - The inbox, written in the use case's transaction, deduplicates by the
 *   envelope messageId: a redelivery after commit is detected and acked
 *   without effects.
 * - DeleteMessage (ack) only after the use case returned, i.e. after commit.
 * - Messages of one MessageGroupId (one wallet) are handled in order; groups
 *   run in parallel.
 * - SIGTERM: stop long polling, let in-flight messages finish (bounded wait),
 *   give the not-yet-started ones back to the queue (visibility 0).
 */
@Injectable()
export class WagerTransactionRequestedConsumer extends PollingWorker {
  static readonly consumerName = 'wager-transactions-consumer';
  /** Observability hook (metrics). */
  static hook: ((event: ConsumerEvent) => void) | undefined;

  private abort = new AbortController();
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSeconds: number;
  private readonly crashAfterCommit: boolean;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly submitWager: SubmitWagerTransactionUseCase,
    config: ConfigService<Env, true>,
  ) {
    super({
      name: 'WagerTransactionRequestedConsumer',
      enabled: config.get('APP_ROLES', { infer: true }).includes('consumer'),
      idleDelayMs: 0, // the long poll already waits
      errorDelayMs: 2000,
      shutdownTimeoutMs: config.get('SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS', { infer: true }),
    });
    this.waitTimeSeconds = config.get('SQS_WAIT_TIME_SECONDS', { infer: true });
    this.visibilityTimeoutSeconds = config.get('SQS_VISIBILITY_TIMEOUT_SECONDS', { infer: true });
    // Test-only fault injection: die after the commit, before the ack.
    this.crashAfterCommit =
      config.get('NODE_ENV', { infer: true }) === 'test' && process.env.CANOPY_CRASH_AFTER_COMMIT === '1';
  }

  override start(): void {
    this.abort = new AbortController();
    super.start();
  }

  protected override onStopRequested(): void {
    this.abort.abort();
  }

  /** One receive + handling of everything received. Public so tests can drive it. */
  pollOnce(): Promise<number> {
    return this.runOnce();
  }

  protected async runOnce(): Promise<number> {
    const queueUrl = await this.queues.url('wager');
    let messages: Message[];
    try {
      const out = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.waitTimeSeconds,
          VisibilityTimeout: this.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.abort.signal },
      );
      messages = out.Messages ?? [];
    } catch (error: unknown) {
      if (this.abort.signal.aborted) return 0;
      throw error;
    }

    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.isStopping) {
            await this.release(queueUrl, message);
          } else {
            await Correlation.run({ correlationId: message.MessageId ?? 'sqs' }, () => this.handle(queueUrl, message));
          }
        }
      }),
    );
    return messages.length;
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const parsed = parseEnvelope(message.Body);
    if (!parsed.ok) {
      await this.toDeadLetter(queueUrl, message, 'INVALID_MESSAGE', parsed.reason);
      return;
    }
    const { data, messageId } = parsed.envelope;
    Correlation.assign({ correlationId: messageId, messageId, providerId: data.providerId, walletId: data.walletId });

    try {
      const result = await this.submitWager.execute(
        { ...data, correlationId: messageId },
        {
          type: 'SQS',
          consumerName: WagerTransactionRequestedConsumer.consumerName,
          messageId,
          messageHash: canonicalHash(data),
        },
      );
      Correlation.assign({ transactionId: result.transactionId });
      if (this.crashAfterCommit) process.exit(137);

      await this.ack(queueUrl, message);
      WagerTransactionRequestedConsumer.hook?.(result.idempotentReplay ? 'duplicate' : 'acked');
      this.logger.log({ msg: 'message processed', status: result.outcome.status, replay: result.idempotentReplay });
    } catch (error: unknown) {
      const disposition = classifyFailure(error);
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (disposition === 'business') {
        await this.ack(queueUrl, message);
        WagerTransactionRequestedConsumer.hook?.('acked');
        this.logger.log({ msg: 'message rejected by business rule', reason });
      } else if (disposition === 'permanent') {
        await this.toDeadLetter(queueUrl, message, 'PERMANENT_FAILURE', reason);
      } else {
        const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
        const delay = retryDelaySeconds(receiveCount);
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }),
        );
        WagerTransactionRequestedConsumer.hook?.('retry');
        this.logger.warn({ msg: 'transient failure, message will be retried', receiveCount, delaySeconds: delay, reason });
      }
    }
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  /** Visibility 0: another consumer (or this one after restart) takes it right away. */
  private async release(queueUrl: string, message: Message): Promise<void> {
    await this.sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }))
      .catch(() => undefined); // worst case the visibility timeout expires on its own
  }

  private async toDeadLetter(queueUrl: string, message: Message, reason: string, detail: string): Promise<void> {
    const dlqUrl = await this.queues.url('wagerDlq');
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          detail: { DataType: 'String', StringValue: detail.slice(0, 500) || 'n/a' },
        },
      }),
    );
    await this.ack(queueUrl, message);
    WagerTransactionRequestedConsumer.hook?.('dlq');
    this.logger.warn({ msg: 'message sent to DLQ', reason, detail: detail.slice(0, 200) });
  }
}

type ParsedEnvelope = { ok: true; envelope: WagerTransactionRequested } | { ok: false; reason: string };

function parseEnvelope(body: string | undefined): ParsedEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  const parsed = wagerTransactionRequestedSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, envelope: parsed.data };
}
