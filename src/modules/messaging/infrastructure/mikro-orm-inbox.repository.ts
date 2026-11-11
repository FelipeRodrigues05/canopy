import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepository } from '../application/ports/inbox.repository';
import type { InboxMessage } from '../domain/inbox-message';
import { InboxMessageRecord } from './messaging.orm-entity';

@Injectable()
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async register(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxMessageRecord)
      .insert({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt,
      })
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }
}
