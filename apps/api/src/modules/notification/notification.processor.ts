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
import { NotificationSettingsService } from './settings/notification-settings.service';
import { DIGEST_SWEEP_JOB } from './settings/notification-settings.constants';
import { OperatorAlertService } from './alerts/operator-alert.service';
import { ALERT_RELEASE_JOB } from './alerts/operator-alert.constants';

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

  constructor(
    private readonly notificationService: NotificationService,
    private readonly settingsService: NotificationSettingsService,
    private readonly alertService: OperatorAlertService,
  ) {}

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

  /**
   * Repeatable sweep for notifications whose delivery job was lost.
   *
   * Cross-tenant, so it carries no job data — the businesses come from the
   * stranded rows themselves. Let it reject: unlike `dispatch`, this job has no
   * retry bookkeeping of its own, so Bull's retries and `QueueTelemetryService`
   * are the error boundary.
   */
  @Process(NOTIFICATION_JOBS.RECOVER_STUCK)
  async handleRecoverStuck(): Promise<void> {
    await this.notificationService.recoverStuck();
  }

  /**
   * Repeatable sweep that cuts every digest which has come due.
   *
   * Same shape and same error boundary as the stuck sweep: cross-tenant, no job
   * data, and left to reject so Bull and queue telemetry can see a failing
   * schedule. Per-business failures are already swallowed inside the sweep, so
   * a rejection here means the scan itself broke.
   */
  @Process(DIGEST_SWEEP_JOB)
  async handleDigestSweep(): Promise<void> {
    const result = await this.settingsService.sweepDueDigests();
    if (result.found > 0) {
      this.logger.log(
        `Digest sweep: ${result.sent} sent, ${result.skipped} skipped of ${result.found} due`,
      );
    }
  }

  /**
   * Repeatable sweep that delivers every alert whose quiet-hours window ended.
   *
   * Same shape and same error boundary as the digest sweep: cross-tenant, no
   * job data, and left to reject so Bull and queue telemetry can see a failing
   * schedule. Per-alert failures are already swallowed inside the sweep, so a
   * rejection here means the scan itself broke.
   */
  @Process(ALERT_RELEASE_JOB)
  async handleAlertRelease(): Promise<void> {
    const result = await this.alertService.sweepDeferred();
    if (result.found > 0) {
      this.logger.log(
        `Operator alert release: ${result.released} sent, ${result.skipped} skipped of ${result.found} due`,
      );
    }
  }
}
