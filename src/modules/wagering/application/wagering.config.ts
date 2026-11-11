/** Pending-reference retry policy (README 7.1). Values come from the environment. */
export abstract class WageringConfig {
  /** After this many lookups without the reference, the transaction is REJECTED. */
  abstract readonly pendingReferenceMaxAttempts: number;
  abstract readonly pendingReferenceBaseDelayMs: number;
  abstract readonly pendingReferenceMaxDelayMs: number;
}

/** Exponential backoff: base, 2x base, 4x base, ... capped. `attempt` starts at 0. */
export function pendingReferenceDelayMs(config: WageringConfig, attempt: number): number {
  return Math.min(config.pendingReferenceBaseDelayMs * 2 ** attempt, config.pendingReferenceMaxDelayMs);
}
