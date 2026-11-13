import { v7 as uuidv7 } from 'uuid';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { brl, newPlayerId } from './fixtures';

export interface WalletHandle {
  walletId: string;
  playerId: string;
}

export async function createWallet(app: INestApplication, initialBalance = '100.00', currency = 'BRL'): Promise<WalletHandle> {
  const playerId = newPlayerId();
  const res = await request(app.getHttpServer())
    .post('/wallets')
    .send({ playerId, initialBalance: { amount: initialBalance, currency } });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(wallet: WalletHandle, kind: string, amount: string, extra: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuidv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    ...extra,
  };
}

/** Default key per README: "{providerId}:{externalTransactionId}". */
export function submit(app: INestApplication, body: WagerBody, key = `${body.providerId}:${body.externalTransactionId}`) {
  return request(app.getHttpServer()).post('/wagering/transactions').set('Idempotency-Key', key).send(body);
}
