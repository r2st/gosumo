import { Module } from '@nestjs/common';
import { WebhookLogController } from './webhook-log.controller';
import { WebhookLogService } from './webhook-log.service';
import { WebhookLogRepository } from './webhook-log.repository';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * WebhookLogModule — read-only inspection over inbound webhook deliveries.
 */
@Module({
  controllers: [WebhookLogController],
  providers: [WebhookLogService, WebhookLogRepository, PrismaService],
  exports: [WebhookLogService],
})
export class WebhookLogModule {}
