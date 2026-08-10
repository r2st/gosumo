import { Process, Processor } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bull';
import { RealtyVisitsService } from './realty-sitevisits.service';
import { RealtyDlqService } from '../realty-hardening/realty-dlq.service';
import {
  REALTY_VISITS_QUEUE,
  REALTY_VISIT_JOBS,
  VisitReminderJobData,
} from './realty-sitevisits.constants';

/** DLQ operation key for a dead-lettered visit reminder. */
export const VISIT_REMINDER_OPERATION = 'realty.visit.reminder';

/**
 * RealtyVisitsProcessor — consumes delayed Bull reminder jobs scheduled by
 * RealtyVisitsService. Fires at T-24h and T-2h before a visit.
 *
 * Phase-7 hardening: each reminder runs through {@link RealtyDlqService} with
 * bounded retries; a reminder that still fails is dead-lettered (captured, never
 * dropped) and swallowed so one bad reminder never wedges the worker. A
 * registered replayer lets an operator re-fire it from the DLQ surface.
 */
@Processor(REALTY_VISITS_QUEUE)
export class RealtyVisitsProcessor implements OnModuleInit {
  private readonly logger = new Logger(RealtyVisitsProcessor.name);

  constructor(
    private readonly visitsService: RealtyVisitsService,
    private readonly dlq: RealtyDlqService,
  ) {}

  onModuleInit(): void {
    this.dlq.registerReplayer(VISIT_REMINDER_OPERATION, async (businessId, payload) => {
      await this.visitsService.fireReminder(
        businessId,
        String(payload['visitId']),
        Number(payload['minutesBefore']),
      );
    });
  }

  @Process(REALTY_VISIT_JOBS.REMINDER)
  async handleReminder(job: Job<VisitReminderJobData>): Promise<void> {
    const { businessId, visitId, minutesBefore } = job.data;
    this.logger.debug(
      `Processing visit reminder for ${visitId} (${minutesBefore}m before)`,
    );
    await this.dlq.runWithRetry(
      businessId,
      {
        source: 'realty-sitevisits',
        operation: VISIT_REMINDER_OPERATION,
        payload: { visitId, minutesBefore },
      },
      () => this.visitsService.fireReminder(businessId, visitId, minutesBefore),
      { swallow: true },
    );
  }
}
