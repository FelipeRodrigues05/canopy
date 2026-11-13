import { defineEntity, type InferEntity, p } from '@mikro-orm/postgresql';
import type { WagerOutcomeSnapshot } from '../domain/wager-transaction';
import { WAGER_KINDS, WAGER_STATUSES } from '../domain/wager-kind';

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.string().length(64),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.enum(WAGER_KINDS),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.enum(WAGER_STATUSES),
    failureCode: p.text().nullable(),
    outcome: p.json<WagerOutcomeSnapshot>().nullable(),
    referenceAttempts: p.integer(),
    nextRetryAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;
