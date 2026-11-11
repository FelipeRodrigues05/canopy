import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CorrelationId } from '../../../shared/presentation/correlation-id.decorator';
import { moneySchema, uuidSchema } from '../../../shared/presentation/schemas';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import type { WalletView } from '../application/wallet.view';

const createWalletSchema = z.object({ playerId: z.uuid(), initialBalance: moneySchema }).strict();
type CreateWalletBody = z.infer<typeof createWalletSchema>;

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
  ) {}

  /** 201 created; 409 when the player already has a wallet in that currency. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body({ schema: createWalletSchema }) body: CreateWalletBody, @CorrelationId() correlationId: string): Promise<WalletView> {
    return this.createWallet.execute({ ...body, correlationId });
  }

  @Get(':walletId')
  get(@Param('walletId', { schema: uuidSchema }) walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }
}
