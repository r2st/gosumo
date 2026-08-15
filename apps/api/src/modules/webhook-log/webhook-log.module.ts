import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { WebhookLogController } from './webhook-log.controller';
import { WebhookLogService } from './webhook-log.service';
import { WebhookLogRepository } from './webhook-log.repository';
import { WebhookDlqRepository } from './webhook-dlq.repository';
import { WebhookDlqService } from './webhook-dlq.service';
import { WebhookDlqProcessor } from './webhook-dlq.processor';
import { WEBHOOK_DLQ_QUEUE } from './webhook-dlq.constants';

/**
 * WebhookLogModule — inbound webhook observability *and* recovery.
 *
 * Two halves that share a subject:
 *  - the read-only delivery log over `webhook_events`, and
 *  - the dead-letter queue ({@link WebhookDlqService} + the `webhook-dlq` Bull
 *    queue + `webhook_dead_letters`), which retries deliveries whose handler
 *    threw. It owns its own table, so the idempotency guarantee the writing
 *    modules take from `webhook_events` is left untouched.
 *
 * Exports the DLQ service so provider-owning modules (payment, channel-adapter)
 * can capture their failures and register a replayer.
 */
@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_DLQ_QUEUE })],
  controllers: [WebhookLogController],
  providers: [
    WebhookLogService,
    WebhookLogRepository,
    WebhookDlqRepository,
    WebhookDlqService,
    WebhookDlqProcessor,
  ],
  exports: [WebhookLogService, WebhookDlqService],
})
export class WebhookLogModule {}
