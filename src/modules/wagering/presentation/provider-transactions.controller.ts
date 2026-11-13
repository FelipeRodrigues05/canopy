import { Controller, Get, Param } from '@nestjs/common';
import type { Principal } from '../../auth/application/provider-identity.port';
import { CurrentPrincipal, assertActsFor } from '../../auth/presentation/principal';
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
    @CurrentPrincipal() principal: Principal,
  ): Promise<TransactionView> {
    assertActsFor(principal, providerId, { allowInternal: true });
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
