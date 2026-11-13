import { z } from 'zod';

/**
 * First barrier for money in every contract: a decimal string with 0 to 2
 * places (A6). Money.from() remains the source of truth.
 */
export const moneySchema = z
  .object({
    amount: z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/, 'amount must be a non-negative decimal string with up to 2 places'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code'),
  })
  .strict();

export const uuidSchema = z.uuid();
