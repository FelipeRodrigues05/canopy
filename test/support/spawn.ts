import type { Subprocess } from 'bun';

export interface Instance {
  proc: Subprocess;
  port: number;
  url: string;
  exited: Promise<number>;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

/**
 * Starts the real service (src/main.ts) as a separate OS process with its own
 * connection pool, exactly as a container would run it.
 */
export async function spawnInstance(options: {
  roles: string;
  port?: number;
  env?: Record<string, string>;
  waitReady?: boolean;
}): Promise<Instance> {
  const port = options.port ?? 40000 + Math.floor(Math.random() * 10000);
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: `${__dirname}/../..`,
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: process.env.INSTANCE_LOG_LEVEL ?? 'silent', APP_ROLES: options.roles, PORT: String(port), ...options.env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const instance: Instance = {
    proc,
    port,
    url: `http://127.0.0.1:${port}`,
    exited: proc.exited,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      proc.kill(signal);
      return proc.exited;
    },
  };
  if (options.waitReady ?? options.roles.includes('api')) await waitReady(instance);
  return instance;
}

async function waitReady(instance: Instance, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.proc.exitCode !== null) throw new Error(`instance exited early with ${instance.proc.exitCode}`);
    try {
      const res = await fetch(`${instance.url}/health/ready`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`instance on ${instance.port} not ready after ${timeoutMs} ms`);
}

/** Polls until `check` returns true or fails after the timeout. No fixed sleeps in tests. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met after ${timeoutMs} ms`);
}
