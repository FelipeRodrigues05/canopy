import { Module } from '@nestjs/common';
import { EventPublisher } from './application/ports/event-publisher';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case';
import { OutboxLagGauge } from './infrastructure/outbox-lag.gauge';
import { SqsEventPublisher } from './infrastructure/sqs-event-publisher';
import { MessagingPersistenceModule } from './messaging-persistence.module';
import { OutboxPublisherWorker } from './presentation/outbox-publisher.worker';

@Module({
  imports: [MessagingPersistenceModule],
  providers: [{ provide: EventPublisher, useClass: SqsEventPublisher }, PublishOutboxUseCase, OutboxPublisherWorker, OutboxLagGauge],
  exports: [PublishOutboxUseCase, OutboxPublisherWorker, OutboxLagGauge],
})
export class MessagingModule {}
