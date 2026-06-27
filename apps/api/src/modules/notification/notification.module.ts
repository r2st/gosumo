import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaService } from '../../common/services/prisma.service';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationRepository } from './notification.repository';
import { NotificationProcessor } from './notification.processor';
import { NotificationEventListener } from './notification.event-listener';
import { TemplateRenderer } from './template-renderer';
import { NotificationRateLimiter } from './notification.rate-limiter';
import { SenderRegistry } from './senders/sender-registry';
import { EmailSender } from './senders/email.sender';
import { SmsSender } from './senders/sms.sender';
import { WhatsAppSender } from './senders/whatsapp.sender';
import { PushSender } from './senders/push.sender';
import { NOTIFICATION_QUEUE } from './notification.constants';

/**
 * NotificationModule — multi-channel notification dispatch (email, SMS,
 * WhatsApp, push), per-tenant templates, event-driven triggers, client
 * preferences/opt-outs, per-channel rate limiting, delivery tracking, retries,
 * and history.
 *
 * Registers the `notifications` Bull queue (Redis connection configured
 * globally in app.module.ts). The event listener subscribes to booking/order/
 * payment domain events and fans them out per the business's triggers.
 */
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATION_QUEUE })],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationRepository,
    NotificationProcessor,
    NotificationEventListener,
    TemplateRenderer,
    SenderRegistry,
    EmailSender,
    SmsSender,
    WhatsAppSender,
    PushSender,
    PrismaService,
    // The rate limiter takes an optional rules map with a default value, so it
    // is constructed via a factory rather than relying on DI for that param.
    {
      provide: NotificationRateLimiter,
      useFactory: () => new NotificationRateLimiter(),
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
