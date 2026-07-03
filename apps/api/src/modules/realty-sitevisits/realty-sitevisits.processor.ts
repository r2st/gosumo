import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { RealtyVisitsService } from './realty-sitevisits.service';
import {
  REALTY_VISITS_QUEUE,
  REALTY_VISIT_JOBS,
  VisitReminderJobData,
} from './realty-sitevisits.constants';

/**
 * RealtyVisitsProcessor — consumes delayed Bull reminder jobs scheduled by
 * RealtyVisitsService. Fires at T-24h and T-2h before a visit, delegating to
 * the service so the same code path is exercised by unit tests.
 */
@Processor(REALTY_VISITS_QUEUE)
export class RealtyVisitsProcessor {
  private readonly logger = new Logger(RealtyVisitsProcessor.name);

  constructor(private readonly visitsService: RealtyVisitsService) {}

  @Process(REALTY_VISIT_JOBS.REMINDER)
  async handleReminder(job: Job<VisitReminderJobData>): Promise<void> {
    const { businessId, visitId, minutesBefore } = job.data;
    this.logger.debug(
      `Processing visit reminder for ${visitId} (${minutesBefore}m before)`,
    );
    await this.visitsService.fireReminder(businessId, visitId, minutesBefore);
  }
}
