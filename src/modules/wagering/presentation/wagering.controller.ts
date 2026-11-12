import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidPayloadError } from '../../../shared/application/application-error';
import { Correlation } from '../../../shared/infrastructure/correlation';
import { CorrelationId } from '../../../shared/presentation/correlation-id.decorator';
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
  get(@Param('transactionId', { schema: uuidSchema }) transactionId: string): Promise<TransactionView> {
    return this.getTransaction.byId(transactionId);
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitWagerResponse> {
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
