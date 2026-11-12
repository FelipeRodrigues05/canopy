import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { isUniqueViolation } from '../../../shared/infrastructure/persistence/pg-errors';
import { WalletRepository } from '../application/ports/wallet.repository';
import { WalletAlreadyExistsError } from '../application/wallet.errors';
import type { Wallet } from '../domain/wallet';
import { WalletMapper } from './wallet.mapper';
import { WalletRecord } from './wallet.orm-entity';

/**
 * Uses native operations (insert, nativeUpdate, findOne with lock) instead of
 * the Unit of Work flush: each statement is explicit and ordered, which the
 * ledger/wallet triggers rely on. The injected EntityManager resolves to the
 * transaction's fork while a UnitOfWork runs.
 */
@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'ux_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(
          `Player ${wallet.playerId} already has a ${wallet.currency.code} wallet`,
          { playerId: wallet.playerId, currency: wallet.currency.code },
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? WalletMapper.toDomain(record) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? WalletMapper.toDomain(record) : null;
  }

  async findByIdForShare(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_READ, disableIdentityMap: true },
    );
    return record ? WalletMapper.toDomain(record) : null;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      // The row is locked FOR UPDATE, so this can only be a bug (lost update).
      throw new InvariantViolationError(`Wallet ${wallet.id} changed under lock (expected version ${expectedVersion})`);
    }
  }
}
