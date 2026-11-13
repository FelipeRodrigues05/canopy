import type { InboxMessage } from '../../domain/inbox-message';

export abstract class InboxRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING inside the current transaction. False
   * when (consumerName, messageId) is already there, which can only mean an
   * earlier delivery committed its effects.
   */
  abstract register(message: InboxMessage): Promise<boolean>;
}
