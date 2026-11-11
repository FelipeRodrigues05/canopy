import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidPayloadError } from '../../../shared/application/application-error';
import { CorrelationId } from '../../../shared/presentation/correlation-id.decorator';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { type SubmitWagerResponse, toSubmitResponse } from './wager-transaction.response';
import { type SubmitWagerBody, idempotencyKeySchema, submitWagerSchema } from './wagering.schemas';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly submitWager: SubmitWagerTransactionUseCase) {}

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
    const result = await this.submitWager.execute({ ...body, idempotencyKey: key.data, correlationId }, { type: 'HTTP' });
    const { status, body: response } = toSubmitResponse(result);
    res.status(status);
    return response;
  }
}
