import { Module } from '@nestjs/common';
import { InboxRepository } from './application/ports/inbox.repository';
import { OutboxRepository } from './application/ports/outbox.repository';
import { MikroOrmInboxRepository } from './infrastructure/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './infrastructure/mikro-orm-outbox.repository';

@Module({
  providers: [
    { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
    { provide: InboxRepository, useClass: MikroOrmInboxRepository },
  ],
  exports: [OutboxRepository, InboxRepository],
})
export class MessagingPersistenceModule {}
