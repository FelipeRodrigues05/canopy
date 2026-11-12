import { z } from 'zod';

export const APP_ROLES = ['api', 'consumer', 'workers'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const roles = z
  .string()
  .default(APP_ROLES.join(','))
  .transform((raw) => raw.split(',').map((r) => r.trim()).filter(Boolean))
  .pipe(z.array(z.enum(APP_ROLES)).min(1));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ROLES: roles,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url(),
  MIGRATOR_DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wallet-events.fifo'),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),

  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
  PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
