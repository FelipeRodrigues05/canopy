import { Module } from '@nestjs/common';
import { OutboxRepository } from './application/ports/outbox.repository';
import { MikroOrmOutboxRepository } from './infrastructure/mikro-orm-outbox.repository';

@Module({
  providers: [{ provide: OutboxRepository, useClass: MikroOrmOutboxRepository }],
  exports: [OutboxRepository],
})
export class MessagingPersistenceModule {}
