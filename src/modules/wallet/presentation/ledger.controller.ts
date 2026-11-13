import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuidSchema } from '../../../shared/presentation/schemas';
import { type LedgerEntryView, ListLedgerUseCase } from '../application/list-ledger.use-case';
import { LedgerCursor } from './ledger-cursor';

const ledgerQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
export class LedgerController {
  constructor(private readonly listLedger: ListLedgerUseCase) {}

  @Get(':walletId/ledger')
  async list(
    @Param('walletId', { schema: uuidSchema }) walletId: string,
    @Query({ schema: ledgerQuerySchema }) query: z.infer<typeof ledgerQuerySchema>,
  ): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }> {
    const page = await this.listLedger.execute(walletId, { beforeSequence: LedgerCursor.decode(query.cursor), limit: query.limit });
    return {
      items: page.items,
      nextCursor: page.nextBeforeSequence === null ? null : LedgerCursor.encode(page.nextBeforeSequence),
    };
  }
}
