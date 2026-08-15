import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
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
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_JOBS,
  STUCK_RECOVERY_CRON,
  STUCK_RECOVERY_REPEAT_JOB_ID,
} from './notification.constants';

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
    // The rate limiter takes an optional rules map with a default value, so it
    // is constructed via a factory rather than relying on DI for that param.
    {
      provide: NotificationRateLimiter,
      useFactory: () => new NotificationRateLimiter(),
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationModule.name);

  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue) {}

  /**
   * Register the stuck-notification sweep as a BullMQ repeatable job. Same
   * shape as the compliance retention sweep: a stable jobId, prior repeatables
   * on a different schedule removed first so a redeploy replaces the schedule
   * rather than accumulating one, and Redis being unavailable (tests/CI) never
   * blocks boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter(
            (job) =>
              job.id === STUCK_RECOVERY_REPEAT_JOB_ID && job.cron !== STUCK_RECOVERY_CRON,
          )
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        NOTIFICATION_JOBS.RECOVER_STUCK,
        {},
        {
          jobId: STUCK_RECOVERY_REPEAT_JOB_ID,
          repeat: { cron: STUCK_RECOVERY_CRON },
          removeOnComplete: true,
          // Kept on purpose, as on the other crons: a sweep that fails is the
          // only signal that stranded notifications are piling up unswept.
          removeOnFail: false,
        },
      );
      this.logger.log(`Scheduled stuck-notification sweep (${STUCK_RECOVERY_CRON})`);
    } catch (err) {
      this.logger.warn(
        `Could not schedule stuck-notification sweep: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
