import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
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
