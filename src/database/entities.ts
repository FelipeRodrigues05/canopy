import { InboxMessageRecord, OutboxMessageRecord } from '../modules/messaging/infrastructure/messaging.orm-entity';
import { WagerTransactionRecord } from '../modules/wagering/infrastructure/wager-transaction.orm-entity';
import { LedgerEntryRecord, WalletRecord } from '../modules/wallet/infrastructure/wallet.orm-entity';

/** Every persistence entity, registered explicitly (no folder discovery). */
export const entities = [
  WalletRecord,
  LedgerEntryRecord,
  WagerTransactionRecord,
  OutboxMessageRecord,
  InboxMessageRecord,
];
