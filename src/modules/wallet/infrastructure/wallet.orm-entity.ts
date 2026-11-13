import { defineEntity, type InferEntity, p } from '@mikro-orm/postgresql';

/**
 * Persistence shapes, separate from the domain classes (RNF08). Money columns
 * are numeric(20,2) mapped in `string` mode: the driver hands us "975.00" and
 * only the mapper turns it into Money. A JS number never holds an amount.
 */
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balance: p.decimal('string').precision(20).scale(2),
    version: p.bigint('number'),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecord>;

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    sequence: p.bigint('number'),
    direction: p.enum(['DEBIT', 'CREDIT'] as const),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().length(3),
    balanceBefore: p.decimal('string').precision(20).scale(2),
    balanceAfter: p.decimal('string').precision(20).scale(2),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRecord = InferEntity<typeof LedgerEntryRecord>;
