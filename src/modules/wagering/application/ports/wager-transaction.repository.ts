import type { WagerTransaction } from '../../domain/wager-transaction';

export abstract class WagerTransactionRepository {
  abstract insert(tx: WagerTransaction): Promise<void>;
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
}
