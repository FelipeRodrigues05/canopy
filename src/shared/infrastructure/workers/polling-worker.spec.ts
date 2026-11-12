import { describe, expect, it } from 'bun:test';
import { PollingWorker } from './polling-worker';

class FakeWorker extends PollingWorker {
  cycles = 0;
  finished = 0;
  gate: Promise<void> = Promise.resolve();

  constructor(private readonly results: (number | Error)[]) {
    super({ name: 'FakeWorker', enabled: false, idleDelayMs: 5, errorDelayMs: 5 });
  }

  protected async runOnce(): Promise<number> {
    const result = this.results[this.cycles++] ?? 0;
    await this.gate;
    this.finished++;
    if (result instanceof Error) throw result;
    return result;
  }
}

describe('PollingWorker', () => {
  it('runs again right away while there is work, waits when idle, survives errors', async () => {
    const worker = new FakeWorker([3, 2, new Error('db down'), 1, 0]);
    worker.start();
    await Bun.sleep(60);
    await worker.stop();
    expect(worker.finished).toBeGreaterThanOrEqual(5);
  });

  it('stop() waits for the running cycle instead of cutting it (graceful SIGTERM)', async () => {
    const worker = new FakeWorker([1]);
    let open!: () => void;
    worker.gate = new Promise((r) => (open = r));
    worker.start();
    await Bun.sleep(5);

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await Bun.sleep(20);
    expect(stopped).toBe(false); // cycle still in flight
    open();
    await stopping;
    expect(worker.finished).toBe(1);
  });

  it('does not start when disabled for this role', () => {
    const worker = new FakeWorker([]);
    worker.onApplicationBootstrap();
    expect(worker.cycles).toBe(0);
  });
});
