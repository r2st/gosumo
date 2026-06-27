import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NotificationService } from './notification.service';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_JOBS,
  DispatchJobData,
  BatchJobData,
} from './notification.constants';

/**
 * NotificationProcessor — consumes the `notifications` Bull queue.
 *
 *  - `dispatch` delivers a single notification (immediate, scheduled, or a
 *    backoff retry re-queued by the service).
 *  - `batch`    delivers one chunk of a bulk/campaign send.
 *
 * The processor holds no business logic; it delegates to the service so the
 * same code paths are covered by the unit tests.
 */
@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly notificationService: NotificationService) {}

  @Process(NOTIFICATION_JOBS.DISPATCH)
  async handleDispatch(job: Job<DispatchJobData>): Promise<void> {
    const { businessId, notificationId } = job.data;
    this.logger.debug(`Dispatch job for notification ${notificationId}`);
    await this.notificationService.processDispatch(businessId, notificationId);
  }

  @Process(NOTIFICATION_JOBS.BATCH)
  async handleBatch(job: Job<BatchJobData>): Promise<void> {
    const { businessId, batchId, notificationIds } = job.data;
    this.logger.debug(
      `Batch job ${batchId}: dispatching ${notificationIds.length} notifications`,
    );
    await this.notificationService.processBatch(businessId, notificationIds);
  }
}
