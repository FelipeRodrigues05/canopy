import { randomUUID } from 'node:crypto';
import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Correlation } from '../correlation';

export interface PollingWorkerOptions {
  name: string;
  /** Start the loop at bootstrap? (APP_ROLES decides.) */
  enabled: boolean;
  /** Wait when a cycle found nothing to do. */
  idleDelayMs: number;
  /** Wait after a cycle threw (database down, broker down...). */
  errorDelayMs: number;
}

/**
 * Background loop shared by the workers. A cycle that did work is followed
 * immediately by the next one; an idle or failed cycle waits. Shutdown stops
 * scheduling new cycles and waits for the running one to finish, so a batch
 * is never cut in half by SIGTERM (its transaction commits or rolls back).
 */
export abstract class PollingWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  protected readonly logger: Logger;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  protected constructor(protected readonly options: PollingWorkerOptions) {
    this.logger = new Logger(options.name);
  }

  /** One cycle. Returns how many items it handled (0 = idle). */
  protected abstract runOnce(): Promise<number>;

  onApplicationBootstrap(): void {
    if (this.options.enabled) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
    this.logger.log({ msg: 'worker started' });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let delay = 0;
      try {
        const handled = await Correlation.run({ correlationId: `${this.options.name}:${randomUUID()}` }, () => this.runOnce());
        if (handled === 0) delay = this.options.idleDelayMs;
      } catch (error: unknown) {
        this.logger.error({ msg: 'worker cycle failed', err: error });
        delay = this.options.errorDelayMs;
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
    this.logger.log({ msg: 'worker stopped' });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
