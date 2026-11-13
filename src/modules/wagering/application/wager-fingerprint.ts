import { canonicalHash } from '../../../shared/infrastructure/canonical-hash';
import { Money, type MoneyProps } from '../../../shared/domain/money';

export interface WagerFingerprintFields {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null | undefined;
}

/**
 * Hash that decides "same request or not" for an idempotency key. Only the
 * business fields take part; the amount is normalized through Money first, so
 * "10", "10.0" and "10.00" are the same request.
 */
export function wagerFingerprint(fields: WagerFingerprintFields): string {
  return canonicalHash({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    walletId: fields.walletId,
    playerId: fields.playerId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.from(fields.money).toProps(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
  });
}
