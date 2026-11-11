export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WAGER_KINDS)[number];

/** OPENING is internal (RF15): only wallet creation produces it. */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

/** Kinds that cannot exist without pointing at an earlier transaction. */
export const KINDS_REQUIRING_REFERENCE: readonly WagerKind[] = ['REFUND', 'ROLLBACK'];

export function isSubmittableKind(kind: unknown): kind is SubmittableKind {
  return typeof kind === 'string' && (SUBMITTABLE_KINDS as readonly string[]).includes(kind);
}

export const WAGER_STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;
export type WagerStatus = (typeof WAGER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly WagerStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];
