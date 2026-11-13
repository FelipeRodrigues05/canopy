/**
 * Blocks until Postgres accepts connections and the SQS queues exist, or fails
 * after a timeout. Used before the integration suites and in CI.
 *
 *   bun scripts/wait-for-deps.ts [timeoutSeconds]
 */
import { SQL } from 'bun';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

const timeoutMs = Number.parseInt(process.argv[2] ?? '90', 10) * 1000;
const deadline = Date.now() + timeoutMs;

async function until(name: string, probe: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await probe();
      console.log(`${name}: ready`);
      return;
    } catch (error: unknown) {
      lastError = error;
      await Bun.sleep(500);
    }
  }
  throw new Error(`${name} not ready after ${timeoutMs} ms: ${String(lastError)}`);
}

async function main(): Promise<void> {
  const dbUrl = process.env.MIGRATOR_DATABASE_URL;
  if (!dbUrl) throw new Error('MIGRATOR_DATABASE_URL is not set');
  const url = dbUrl;

  await until('postgres', async () => {
    const sql = new SQL(url);
    try {
      await sql`select 1`;
    } finally {
      await sql.close();
    }
  });

  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  for (const queue of ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wallet-events.fifo']) {
    await until(`sqs ${queue}`, () => sqs.send(new GetQueueUrlCommand({ QueueName: queue })));
  }
  sqs.destroy();

  const issuer = process.env.AUTH_TEST_ISSUER ?? (process.env.AUTH_ENABLED === 'true' ? process.env.AUTH_ISSUER : undefined);
  if (issuer) {
    await until('keycloak', async () => {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`status ${res.status}`);
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
