import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { WebhookDlqService } from './webhook-dlq.service';
import {
  WEBHOOK_DLQ_JOBS,
  WEBHOOK_DLQ_QUEUE,
  WEBHOOK_DLQ_SWEEP_CRON,
  WEBHOOK_DLQ_SWEEP_JOB_ID,
} from './webhook-dlq.constants';

export interface WebhookRetryJobData {
  deadLetterId: string;
  businessId: string | null;
}

/**
 * WebhookDlqProcessor — drains the `webhook-dlq` queue.
 *
 * Two job types, both delegating to {@link WebhookDlqService} so the retry
 * state machine has exactly one implementation:
 *
 *  - `webhook.retry` — one backoff-scheduled attempt at a parked delivery.
 *  - `webhook.sweep` — a repeatable safety net that re-enqueues entries whose
 *    `next_retry_at` has passed but whose job never arrived (Redis flushed, or
 *    the process died between the DB write and the enqueue). Without it, a lost
 *    job means a webhook parked forever with nothing to wake it.
 *
 * Neither handler rethrows. Bull's own retry is deliberately not in play here:
 * the attempt budget and backoff live in the DB row, and a second retry engine
 * on top would spend that budget in seconds.
 */
@Processor(WEBHOOK_DLQ_QUEUE)
export class WebhookDlqProcessor implements OnModuleInit {
  private readonly logger = new Logger(WebhookDlqProcessor.name);

  constructor(
    @InjectQueue(WEBHOOK_DLQ_QUEUE) private readonly queue: Queue,
    private readonly dlq: WebhookDlqService,
  ) {}

  /** Register the recovery sweep once, under a stable id so deploys don't stack it. */
  async onModuleInit(): Promise<void> {
    try {
      // A stable jobId alone only dedupes an *unchanged* schedule. Bull keys a
      // repeatable by (name, cron, jobId), so editing the cron registers a
      // second repeatable beside the first and the old schedule keeps firing
      // forever — nothing ever removes it, and it survives every later deploy.
      // Two live sweeps means `sweepDue()` runs twice, and each run re-enqueues
      // the same due entries: duplicate delivery attempts against endpoints
      // that already have a bounded attempt budget in the DB row. Clear any
      // prior repeatable carrying this id under a different cron first, which
      // is what the module-level registrations (compliance, realty-ingestion,
      // realty-integrations) already do.
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter(
            (job) =>
              job.id === WEBHOOK_DLQ_SWEEP_JOB_ID && job.cron !== WEBHOOK_DLQ_SWEEP_CRON,
          )
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        WEBHOOK_DLQ_JOBS.SWEEP,
        {},
        {
          repeat: { cron: WEBHOOK_DLQ_SWEEP_CRON },
          jobId: WEBHOOK_DLQ_SWEEP_JOB_ID,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
      this.logger.log(
        `Registered webhook DLQ recovery sweep (cron "${WEBHOOK_DLQ_SWEEP_CRON}")`,
      );
    } catch (err) {
      // A missing sweep degrades recovery to "whatever Redis delivered"; it
      // must not stop the app from booting.
      this.logger.error(
        `Failed to register webhook DLQ sweep: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Process(WEBHOOK_DLQ_JOBS.RETRY)
  async handleRetry(job: Job<WebhookRetryJobData>): Promise<void> {
    const { deadLetterId, businessId } = job.data ?? { deadLetterId: '', businessId: null };
    if (!deadLetterId) {
      this.logger.warn('Webhook retry job arrived with no deadLetterId — dropping');
      return;
    }

    try {
      const outcome = await this.dlq.runRetry(businessId ?? null, deadLetterId);
      this.logger.debug(`Webhook retry ${deadLetterId} → ${outcome.status}`);
    } catch (err) {
      // The entry was deleted, or the DB is down. Either way the row (if it
      // still exists) keeps its `next_retry_at` and the sweep will return.
      this.logger.error(
        `Webhook retry ${deadLetterId} could not run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Process(WEBHOOK_DLQ_JOBS.SWEEP)
  async handleSweep(): Promise<void> {
    try {
      await this.dlq.sweepDue();
    } catch (err) {
      this.logger.error(
        `Webhook DLQ sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
