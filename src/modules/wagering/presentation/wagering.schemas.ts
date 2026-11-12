import { z } from 'zod';
import { moneySchema } from '../../../shared/presentation/schemas';
import { SUBMITTABLE_KINDS } from '../domain/wager-kind';

const id = (max: number) => z.string().min(1).max(max).regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces');

/** README 9 contract. OPENING is not in the enum: it can never be submitted (RF15). */
export const submitWagerSchema = z
  .object({
    providerId: id(100),
    externalTransactionId: id(200),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: id(200),
    gameId: id(200),
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: id(200).optional(),
  })
  .strict();
export type SubmitWagerBody = z.infer<typeof submitWagerSchema>;

export const idempotencyKeySchema = id(300);
export const externalIdSchema = id(200);

/** SQS message (README 10). The envelope messageId is the inbox deduplication key. */
export const wagerTransactionRequestedSchema = z.object({
  messageId: id(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: submitWagerSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});
export type WagerTransactionRequested = z.infer<typeof wagerTransactionRequestedSchema>;
