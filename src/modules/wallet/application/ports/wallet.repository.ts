import type { Wallet } from '../../domain/wallet';

export abstract class WalletRepository {
  /** Throws WalletAlreadyExistsError when (playerId, currency) is taken. */
  abstract insert(wallet: Wallet): Promise<void>;
  abstract findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE: the row stays locked until the transaction ends. Needs a UnitOfWork. */
  abstract findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** Persists balance and version, guarded by the version read under lock. */
  abstract saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
