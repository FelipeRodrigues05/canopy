import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const out = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!out.QueueUrl) throw new Error(`no url for ${name}`);
  return out.QueueUrl;
}

/**
 * Receives and deletes everything currently in a queue. Stops after
 * `emptyPolls` consecutive empty receives (FIFO groups can hide messages
 * briefly while others in the group are in flight).
 */
export async function drainQueue(sqs: SQSClient, name: string, emptyPolls = 2): Promise<Message[]> {
  const url = await queueUrl(sqs, name);
  const all: Message[] = [];
  let empty = 0;
  while (empty < emptyPolls) {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) {
      empty++;
      continue;
    }
    empty = 0;
    all.push(...messages);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle ?? '' })),
      }),
    );
  }
  return all;
}

export const WAGER_QUEUE = 'wager-transactions.fifo';
export const WAGER_DLQ = 'wager-transactions-dlq.fifo';

export interface RequestedEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Sends to the wager queue as a provider would. `dedupId` defaults to a fresh one (bypasses FIFO dedup). */
export async function sendWagerMessage(
  sqs: SQSClient,
  body: RequestedEnvelope | string,
  options: { groupId?: string; dedupId?: string } = {},
): Promise<void> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const walletId = typeof body === 'string' ? undefined : body.data.walletId;
  const group = options.groupId ?? (typeof walletId === 'string' ? walletId : 'raw');
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(sqs, WAGER_QUEUE),
      MessageBody: raw,
      MessageGroupId: group,
      MessageDeduplicationId: options.dedupId ?? crypto.randomUUID(),
    }),
  );
}

/** Visible + in-flight (invisible) messages. Zero means everything was acked or moved. */
export async function queueDepth(sqs: SQSClient, name: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(sqs, name),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number.parseInt(out.Attributes?.ApproximateNumberOfMessages ?? '0', 10) +
    Number.parseInt(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10)
  );
}
