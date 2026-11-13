import { $ } from 'bun';

/** Runs the migration CLI as a child process, exactly as an operator would. */
export async function migrate(...args: string[]): Promise<string> {
  const out = await $`bun scripts/migrate.ts ${args}`.env({ ...process.env, NODE_ENV: 'test' }).quiet();
  return out.stdout.toString();
}
