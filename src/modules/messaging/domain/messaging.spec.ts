import { describe, expect, it } from 'bun:test';
import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { Money } from '../../../shared/domain/money';
import { NOW, processed, tx, wallet } from '../../wagering/domain/__fixtures__/wager.fixtures';
import { WagerTransactionProcessed } from '../../wagering/domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../wagering/domain/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../wagering/domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed.event';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

describe('InboxMessage', () => {
  it('is processed exactly once', () => {
    const msg = InboxMessage.receive({ consumerName: 'wager-consumer', messageId: 'm1', payloadHash: 'h', now: NOW });
    expect(msg.isProcessed).toBe(false);
    msg.markProcessed(NOW);
    expect(msg.isProcessed).toBe(true);
    expect(() => msg.markProcessed(NOW)).toThrow(InvariantViolationError);
  });

  it('needs a consumer and a message id', () => {
    expect(() => InboxMessage.receive({ consumerName: '', messageId: 'm', payloadHash: 'h', now: NOW })).toThrow(InvariantViolationError);
  });
});

describe('OutboxMessage', () => {
  const ctx = (eventId = 'evt-1') => ({ eventId, correlationId: 'corr-1' });
  const event = WagerTransactionProcessed.from(processed(tx()), ctx());

  it('takes its id from the event id (consumers dedupe by it)', () => {
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe('evt-1');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.publishedAt).toBeNull();
    expect(msg.nextAttemptAt).toEqual(event.occurredAt);
    expect(msg.isDue(event.occurredAt)).toBe(true);
    expect(msg.isDue(new Date(event.occurredAt.getTime() - 1))).toBe(false);
  });

  it('backs off exponentially up to 5 minutes on failure', () => {
    const msg = OutboxMessage.enqueue(event);
    msg.scheduleRetry(NOW, 'boom');
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt.getTime() - NOW.getTime()).toBe(1000);
    msg.scheduleRetry(NOW, 'boom');
    expect(msg.nextAttemptAt.getTime() - NOW.getTime()).toBe(2000);
    expect(OutboxMessage.backoffMs(30)).toBe(300_000);
  });

  it('is published once', () => {
    const msg = OutboxMessage.enqueue(event);
    msg.markPublished(NOW);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(NOW)).toThrow(InvariantViolationError);
  });
});

describe('integration events', () => {
  const ctx = { eventId: 'e', correlationId: 'corr-1', causationId: 'msg-1' };

  it('carry money as strings, never Money instances or numbers', () => {
    const t = processed(tx({ amount: '12.5' }));
    const envelope = WagerTransactionProcessed.from(t, ctx).toJSON();
    expect(envelope).toMatchObject({ eventType: 'WagerTransactionProcessed', version: 1, aggregateId: t.id, correlationId: 'corr-1', causationId: 'msg-1' });
    expect(envelope.data.money).toEqual({ amount: '12.50', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope as unknown as Record<string, unknown>);
  });

  it('refuse to describe a transaction in the wrong state', () => {
    expect(() => WagerTransactionProcessed.from(tx(), ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(processed(tx()), ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(tx(), ctx, NOW)).toThrow(InvariantViolationError);
  });

  it('rejected event carries the failure code', () => {
    const t = tx();
    t.reject('INSUFFICIENT_FUNDS', NOW);
    expect(WagerTransactionRejected.from(t, ctx).data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('balance changed event mirrors the ledger entry', () => {
    const w = wallet('100.00');
    const entry = w.debit({ entryId: 'le', transactionId: 't', amount: Money.from('30', 'BRL'), at: NOW });
    const e = WalletBalanceChanged.from(w, entry, ctx);
    expect(e.eventType).toBe('WalletBalanceChanged');
    expect(e.data).toMatchObject({
      walletId: 'w1', walletVersion: 2, direction: 'DEBIT', money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '70.00', currency: 'BRL' },
    });
  });
});
