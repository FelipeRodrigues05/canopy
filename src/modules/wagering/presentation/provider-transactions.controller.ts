import { Controller, Get, Param } from '@nestjs/common';
import { GetTransactionUseCase } from '../application/get-transaction.use-case';
import type { TransactionView } from '../application/transaction.view';
import { externalIdSchema } from './wagering.schemas';

/** Lookup by the provider's own id: what a provider has when it lost our response. */
@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(private readonly getTransaction: GetTransactionUseCase) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId', { schema: externalIdSchema }) providerId: string,
    @Param('externalTransactionId', { schema: externalIdSchema }) externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
