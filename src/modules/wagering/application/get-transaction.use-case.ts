import { Injectable } from '@nestjs/common';
import { WagerTransactionRepository } from './ports/wager-transaction.repository';
import { type TransactionView, toTransactionView } from './transaction.view';
import { TransactionNotFoundError } from './wagering.errors';

@Injectable()
export class GetTransactionUseCase {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  async byId(transactionId: string): Promise<TransactionView> {
    const tx = await this.transactions.findById(transactionId);
    if (!tx) throw new TransactionNotFoundError(`Transaction ${transactionId} not found`, { transactionId });
    return toTransactionView(tx);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.transactions.findByExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new TransactionNotFoundError(`Transaction ${providerId}/${externalTransactionId} not found`, {
        providerId,
        externalTransactionId,
      });
    }
    return toTransactionView(tx);
  }
}
