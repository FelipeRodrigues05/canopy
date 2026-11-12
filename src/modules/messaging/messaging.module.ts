import { Module } from '@nestjs/common';
import { EventPublisher } from './application/ports/event-publisher';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case';
import { SqsEventPublisher } from './infrastructure/sqs-event-publisher';
import { MessagingPersistenceModule } from './messaging-persistence.module';
import { OutboxPublisherWorker } from './presentation/outbox-publisher.worker';

@Module({
  imports: [MessagingPersistenceModule],
  providers: [{ provide: EventPublisher, useClass: SqsEventPublisher }, PublishOutboxUseCase, OutboxPublisherWorker],
  exports: [PublishOutboxUseCase, OutboxPublisherWorker],
})
export class MessagingModule {}
