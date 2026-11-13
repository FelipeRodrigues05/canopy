import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidPayloadError } from '../../../shared/application/application-error';
import { Correlation } from '../../../shared/infrastructure/correlation';
import { CorrelationId } from '../../../shared/presentation/correlation-id.decorator';
import type { Principal } from '../../auth/application/provider-identity.port';
import { CurrentPrincipal, assertActsFor } from '../../auth/presentation/principal';
import { TransactionNotFoundError } from '../application/wagering.errors';
import { GetTransactionUseCase } from '../application/get-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import type { TransactionView } from '../application/transaction.view';
import { uuidSchema } from '../../../shared/presentation/schemas';
import { type SubmitWagerResponse, toSubmitResponse } from './wager-transaction.response';
import { type SubmitWagerBody, idempotencyKeySchema, submitWagerSchema } from './wagering.schemas';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly submitWager: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  @Get(':transactionId')
  async get(
    @Param('transactionId', { schema: uuidSchema }) transactionId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TransactionView> {
    const view = await this.getTransaction.byId(transactionId);
    // Another provider's transaction answers 404, not 403: do not confirm that an id exists.
    if (principal.providerId !== null && principal.providerId !== view.providerId) {
      throw new TransactionNotFoundError(`Transaction ${transactionId} not found`, { transactionId });
    }
    return view;
  }

  /**
   * 200 processed | 202 waiting for its reference | 422 rejected by a business
   * rule (failureCode) | 400 invalid payload or missing Idempotency-Key |
   * 409 key reused with another payload | 503 transient, retry.
   */
  @Post()
  async submit(
    @Body({ schema: submitWagerSchema }) body: SubmitWagerBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CorrelationId() correlationId: string,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitWagerResponse> {
    // 403 before anything else: a provider only submits in its own name.
    assertActsFor(principal, body.providerId, { allowInternal: false });
    const key = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) {
      throw new InvalidPayloadError('Idempotency-Key header is required (1-300 printable characters)');
    }
    // Every later log line of this request carries these ids (README 12).
    Correlation.assign({ providerId: body.providerId, walletId: body.walletId });
    const result = await this.submitWager.execute({ ...body, idempotencyKey: key.data, correlationId }, { type: 'HTTP' });
    Correlation.assign({ transactionId: result.transactionId });
    const { status, body: response } = toSubmitResponse(result);
    res.status(status);
    return response;
  }
}
