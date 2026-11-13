/**
 * Load test: `bun run test:load`
 *
 * 1. Starts the full stack with 3 app replicas behind nginx (round robin).
 * 2. Gets a provider token from Keycloak.
 * 3. Runs closed-loop scenarios (N virtual clients, each sends its next request
 *    as soon as the previous one answers) for a fixed duration:
 *      - distributed: many wallets, BET/WIN mix with 5% idempotent replays
 *      - hot-wallet:  a handful of wallets, maximum lock contention
 *      - sqs:         a burst of queue messages, drained by the 3 consumers
 * 4. Reads /metrics of every replica before/after (lock conflicts, retries,
 *    duplicates), samples outbox lag, reconciles every wallet touched.
 * 5. Writes test/load/REPORT.md and test/load/results.json.
 *
 * Knobs: LOAD_DURATION_S (30), LOAD_CONCURRENCY (64), LOAD_WALLETS (500),
 * LOAD_HOT_WALLETS (3), LOAD_SQS_MESSAGES (3000), LOAD_KEEP_STACK=1 to leave
 * the stack running.
 */
import { $ } from 'bun';
import { cpus, totalmem, release } from 'node:os';
import { SQSClient, SendMessageBatchCommand, GetQueueUrlCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

const DURATION_S = Number.parseInt(process.env.LOAD_DURATION_S ?? '30', 10);
const CONCURRENCY = Number.parseInt(process.env.LOAD_CONCURRENCY ?? '64', 10);
const WALLETS = Number.parseInt(process.env.LOAD_WALLETS ?? '500', 10);
const HOT_WALLETS = Number.parseInt(process.env.LOAD_HOT_WALLETS ?? '3', 10);
const SQS_MESSAGES = Number.parseInt(process.env.LOAD_SQS_MESSAGES ?? '3000', 10);

const LB = 'http://localhost:8088';
const REPLICAS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
const ISSUER = 'http://localhost:8080/realms/wagering';
const COMPOSE = ['-f', 'docker-compose.yaml', '-f', 'docker-compose.load.yaml'];
const ROOT = `${__dirname}/../..`;

interface Sample {
  ms: number;
  status: number;
}

interface ScenarioResult {
  name: string;
  description: string;
  durationS: number;
  requests: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
  errorRate: number;
  businessRejections: number;
  metricsDelta: Record<string, number>;
  outboxLagMaxS: number;
  outboxLagAfterS: number;
}

// ---------------------------------------------------------------- helpers

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

let token = '';
let tokenExpiresAt = 0;
async function bearer(): Promise<string> {
  if (Date.now() < tokenExpiresAt - 30_000) return token;
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'provider-a', client_secret: 'provider-a-secret' }),
  });
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = body.access_token;
  tokenExpiresAt = Date.now() + body.expires_in * 1000;
  return token;
}

async function api(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${LB}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await bearer()}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Sum of a metric (all label sets) across the 3 replicas. Counters are per process. */
async function metricTotals(names: string[]): Promise<Record<string, number>> {
  const totals: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  for (const replica of REPLICAS) {
    const text = await (await fetch(`${replica}/metrics`)).text();
    for (const line of text.split('\n')) {
      for (const name of names) {
        if (line.startsWith(`${name}{`) || line.startsWith(`${name} `)) {
          totals[name] = (totals[name] ?? 0) + Number.parseFloat(line.split(' ').at(-1) ?? '0');
        }
      }
    }
  }
  return totals;
}

async function outboxLag(): Promise<number> {
  const text = await (await fetch(`${REPLICAS[0]}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith('outbox_lag_seconds '));
  return line ? Number.parseFloat(line.split(' ')[1] ?? '0') : 0;
}

const WATCHED = [
  'wager_transactions_total',
  'lock_conflicts_total',
  'processing_retries_total',
  'idempotent_duplicates_total',
  'outbox_published_total',
  'dlq_messages_total',
];

interface Wallet {
  walletId: string;
  playerId: string;
}

async function createWallets(count: number, amount: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  const queue = Array.from({ length: count }, () => crypto.randomUUID());
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let playerId = queue.pop(); playerId; playerId = queue.pop()) {
        const res = await api('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
        if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.json)}`);
        wallets.push({ walletId: String(res.json.id), playerId });
      }
    }),
  );
  return wallets;
}

function wagerBody(w: Wallet, kind: string, amount: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `load-${crypto.randomUUID()}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: `round-${Math.floor(Math.random() * 1e6)}`,
    gameId: 'load-test',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

// ---------------------------------------------------------------- HTTP scenarios

async function httpScenario(name: string, description: string, wallets: Wallet[]): Promise<ScenarioResult> {
  console.log(`\n▶ ${name}: ${CONCURRENCY} clients x ${DURATION_S}s over ${wallets.length} wallet(s)`);
  const before = await metricTotals(WATCHED);
  const samples: Sample[] = [];
  const sent: ReturnType<typeof wagerBody>[] = [];
  let lagMax = 0;
  const deadline = Date.now() + DURATION_S * 1000;

  const sampler = (async () => {
    while (Date.now() < deadline) {
      lagMax = Math.max(lagMax, await outboxLag().catch(() => 0));
      await Bun.sleep(500);
    }
  })();

  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const r = Math.random();
        // 5% replays of an earlier request (same key and body): must be answered, never re-applied.
        const body =
          r < 0.05 && sent.length > 0
            ? sent[Math.floor(Math.random() * sent.length)]!
            : wagerBody(wallets[Math.floor(Math.random() * wallets.length)]!, r < 0.85 ? 'BET' : 'WIN', r < 0.85 ? '1.00' : '1.50');
        if (r >= 0.05) sent.push(body);
        const t0 = performance.now();
        let status = 0;
        try {
          status = (await api('/wagering/transactions', body, { 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` })).status;
        } catch {
          status = 0; // connection error
        }
        samples.push({ ms: performance.now() - t0, status });
      }
    }),
  );
  const elapsedS = (performance.now() - started) / 1000;
  await sampler;

  // Let the publishers catch up, then record what is left.
  await Bun.sleep(2000);
  const lagAfter = await outboxLag();
  const after = await metricTotals(WATCHED);

  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;

  const result: ScenarioResult = {
    name,
    description,
    durationS: round(elapsedS),
    requests: samples.length,
    throughput: round(samples.length / elapsedS),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
    statuses,
    errorRate: round((errors / Math.max(1, samples.length)) * 100, 3),
    businessRejections: statuses['422'] ?? 0,
    metricsDelta: Object.fromEntries(WATCHED.map((n) => [n, round((after[n] ?? 0) - (before[n] ?? 0), 0)])),
    outboxLagMaxS: round(lagMax, 2),
    outboxLagAfterS: round(lagAfter, 2),
  };
  console.log(`  ${result.requests} req, ${result.throughput} req/s, p50 ${result.p50} ms, p95 ${result.p95} ms, p99 ${result.p99} ms, errors ${result.errorRate}%`);
  return result;
}

// ---------------------------------------------------------------- SQS scenario

async function sqsScenario(wallets: Wallet[]): Promise<{ messages: number; drainS: number; throughput: number; metricsDelta: Record<string, number> }> {
  console.log(`\n▶ sqs: ${SQS_MESSAGES} messages over ${wallets.length} wallets, drained by 3 consumers`);
  const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))).QueueUrl!;
  const before = await metricTotals(WATCHED);

  const entries = Array.from({ length: SQS_MESSAGES }, (_, i) => {
    const w = wallets[i % wallets.length]!;
    const body = wagerBody(w, 'BET', '1.00');
    const messageId = `load-msg-${crypto.randomUUID()}`;
    return {
      Id: String(i % 10),
      MessageGroupId: w.walletId,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
      }),
    };
  });
  const t0 = performance.now();
  for (let i = 0; i < entries.length; i += 10) {
    await sqs.send(new SendMessageBatchCommand({ QueueUrl: url, Entries: entries.slice(i, i + 10) }));
  }
  for (;;) {
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    );
    const depth =
      Number.parseInt(attrs.Attributes?.ApproximateNumberOfMessages ?? '0', 10) +
      Number.parseInt(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
    if (depth === 0) break;
    await Bun.sleep(250);
  }
  const drainS = (performance.now() - t0) / 1000;
  const after = await metricTotals(WATCHED);
  sqs.destroy();
  const result = {
    messages: SQS_MESSAGES,
    drainS: round(drainS),
    throughput: round(SQS_MESSAGES / drainS),
    metricsDelta: Object.fromEntries(WATCHED.map((n) => [n, round((after[n] ?? 0) - (before[n] ?? 0), 0)])),
  };
  console.log(`  drained in ${result.drainS}s (${result.throughput} msg/s)`);
  return result;
}

// ---------------------------------------------------------------- reconciliation

async function reconcileAll(wallets: Wallet[]): Promise<{ checked: number; inconsistent: string[] }> {
  const inconsistent: string[] = [];
  const queue = [...wallets];
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let w = queue.pop(); w; w = queue.pop()) {
        const res = await api(`/wallets/${w.walletId}/reconciliation`, {});
        if (res.status !== 200 || res.json.consistent !== true) inconsistent.push(w.walletId);
      }
    }),
  );
  return { checked: wallets.length, inconsistent };
}

// ---------------------------------------------------------------- report

function report(env: Record<string, string>, scenarios: ScenarioResult[], sqs: Awaited<ReturnType<typeof sqsScenario>>, recon: { checked: number; inconsistent: string[] }): string {
  const row = (s: ScenarioResult) =>
    `| ${s.name} | ${s.requests} | ${s.throughput} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} | ${s.errorRate}% | ${s.businessRejections} |`;
  const metricsRow = (s: { name?: string; metricsDelta: Record<string, number> }, name: string) =>
    `| ${name} | ${WATCHED.map((m) => s.metricsDelta[m] ?? 0).join(' | ')} |`;
  return `# Load test report

Generated by \`bun run test:load\` on ${env.date}.

## Environment

| | |
|---|---|
| CPU | ${env.cpu} (${env.cores} logical cores) |
| Memory | ${env.memory} |
| OS / kernel | ${env.os} |
| Bun | ${env.bun} |
| Docker | ${env.docker} |
| Topology | 3 app replicas (api + consumer + workers each) behind nginx round robin; PostgreSQL 16 (fsync on), LocalStack 4.9 (SQS), Keycloak 26 |
| Pools | ${env.pool} DB connections per replica |

**Everything runs on one machine**: the load generator, nginx, three replicas, Postgres, LocalStack and Keycloak share ${env.cores} cores. Absolute numbers are a lower bound for a real deployment; the value of this test is in the *relative* behaviour (distributed vs hot wallet), the correctness checks and the error profile.

## Methodology

- Closed loop: ${CONCURRENCY} virtual clients, each sends its next request as soon as the previous one answers, for ${DURATION_S}s per HTTP scenario. Latency is measured client side (through nginx, including TLS-free HTTP, auth and the full SQL transaction).
- Request mix: 80% \`BET 1.00\`, 15% \`WIN 1.50\`, 5% idempotent replays of an earlier request (same key and body).
- Bearer token from Keycloak (\`provider-a\`, client credentials); every request is authenticated.
- \`distributed\`: ${WALLETS} wallets; \`hot-wallet\`: ${HOT_WALLETS} wallet(s), so most requests queue for the same row lock.
- \`sqs\`: ${SQS_MESSAGES} \`WagerTransactionRequested\` messages (one FIFO group per wallet) sent in batches, timed until the queue is empty (visible + in flight).
- Counters come from \`/metrics\` of each replica (before/after deltas, summed); \`outbox_lag_seconds\` sampled every 500 ms.
- Afterwards every wallet is reconciled through \`POST /wallets/:id/reconciliation\`.

## HTTP results

| Scenario | Requests | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Error rate (5xx/network) | Business rejections (422) |
|---|---|---|---|---|---|---|---|---|
${scenarios.map(row).join('\n')}

Status codes: ${scenarios.map((s) => `**${s.name}** ${JSON.stringify(s.statuses)}`).join('; ')}

## Concurrency and messaging counters (sum of the 3 replicas)

| Scenario | ${WATCHED.join(' | ')} |
|---|${WATCHED.map(() => '---').join('|')}|
${scenarios.map((s) => metricsRow(s, s.name)).join('\n')}
${metricsRow(sqs, 'sqs')}

## Outbox lag

| Scenario | max during run (s) | 2 s after run (s) |
|---|---|---|
${scenarios.map((s) => `| ${s.name} | ${s.outboxLagMaxS} | ${s.outboxLagAfterS} |`).join('\n')}

## SQS

${sqs.messages} messages drained in **${sqs.drainS}s** (**${sqs.throughput} msg/s**) by 3 consumers.

## Consistency

Reconciled **${recon.checked}** wallets: **${recon.inconsistent.length === 0 ? 'all consistent' : `${recon.inconsistent.length} inconsistent`}** (stored balance = balance rebuilt from the ledger, latest entry = version).

${ANALYSIS_PLACEHOLDER}
`;
}

const ANALYSIS_PLACEHOLDER = '<!-- analysis -->';

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  process.chdir(ROOT);
  console.log('Starting stack (3 replicas + nginx)...');
  await $`docker compose ${COMPOSE} up -d --build --scale app=3 --wait`.quiet();

  const env = {
    date: new Date().toISOString(),
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: String(cpus().length),
    memory: `${Math.round(totalmem() / 1024 ** 3)} GB`,
    os: `${process.platform} ${release()}`,
    bun: Bun.version,
    docker: (await $`docker version --format '{{.Server.Version}}'`.text()).trim(),
    pool: '15',
  };

  const distributedWallets = await createWallets(WALLETS, '100000.00');
  const hotWallets = await createWallets(HOT_WALLETS, '1000000.00');

  const scenarios = [
    await httpScenario('distributed', 'many wallets, little contention', distributedWallets),
    await httpScenario('hot-wallet', `${HOT_WALLETS} wallet(s), maximum contention`, hotWallets),
  ];
  const sqs = await sqsScenario(distributedWallets.slice(0, 200));

  console.log('\nReconciling every wallet...');
  const recon = await reconcileAll([...distributedWallets, ...hotWallets]);
  console.log(`  ${recon.checked} checked, ${recon.inconsistent.length} inconsistent`);

  await Bun.write('test/load/results.json', JSON.stringify({ env, scenarios, sqs, reconciliation: recon }, null, 2));
  const previous = await Bun.file('test/load/REPORT.md').text().catch(() => '');
  const analysis = previous.includes('## Analysis') ? previous.slice(previous.indexOf('## Analysis')) : ANALYSIS_PLACEHOLDER;
  await Bun.write('test/load/REPORT.md', report(env, scenarios, sqs, recon).replace(ANALYSIS_PLACEHOLDER, analysis));
  console.log('\nWrote test/load/REPORT.md and test/load/results.json');

  if (process.env.LOAD_KEEP_STACK !== '1') {
    await $`docker compose ${COMPOSE} down`.quiet();
  }
  if (recon.inconsistent.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
