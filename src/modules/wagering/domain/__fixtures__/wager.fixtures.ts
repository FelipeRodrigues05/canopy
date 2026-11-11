import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../../wallet/domain/wallet';
import { WagerTransaction, type SubmitWagerInput } from '../wager-transaction';

/** Builders shared by the domain unit tests. Not used by production code. */
export const NOW = new Date('2026-11-11T12:00:00Z');
let counter = 0;

export function wallet(balance = '100.00', overrides: { playerId?: string; currency?: string } = {}): Wallet {
  return Wallet.open({
    id: 'w1',
    playerId: overrides.playerId ?? 'p1',
    initialBalance: Money.from(balance, overrides.currency ?? 'BRL'),
    now: NOW,
    opening: { entryId: 'e0', transactionId: 'opening' },
  }).wallet;
}

export function tx(overrides: Partial<Omit<SubmitWagerInput, 'amount'>> & { amount?: string; currency?: string } = {}): WagerTransaction {
  counter += 1;
  const { amount = '10.00', currency = 'BRL', ...rest } = overrides;
  return WagerTransaction.submit({
    id: `tx-${counter}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${counter}`,
    idempotencyKey: `key-${counter}`,
    payloadHash: 'h'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    referenceExternalTransactionId: null,
    now: NOW,
    ...rest,
    amount: Money.from(amount, currency),
  });
}

export function processed(t: WagerTransaction): WagerTransaction {
  t.markProcessed(NOW);
  return t;
}
