import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { COMPLIANCE_QUEUE, COMPLIANCE_JOBS } from './compliance.constants';

/**
 * RetentionProcessor — consumes the `compliance` queue's weekly retention sweep.
 * Holds no business logic; delegates to {@link RetentionService} so the same code
 * path is exercised by the unit tests and by a manual trigger.
 */
@Processor(COMPLIANCE_QUEUE)
export class RetentionProcessor {
  private readonly logger = new Logger(RetentionProcessor.name);

  constructor(private readonly retention: RetentionService) {}

  @Process(COMPLIANCE_JOBS.RETENTION_SWEEP)
  async handleRetentionSweep(): Promise<void> {
    this.logger.log('Running scheduled DPDPA retention sweep');
    const { results, businessesSkipped, businessesPending } =
      await this.retention.runAll();
    const leads = results.reduce((sum, r) => sum + r.leadsAnonymized, 0);
    const messages = results.reduce((sum, r) => sum + r.messagesAnonymized, 0);
    const summary =
      `${results.length} business(es), ${leads} lead(s), ` +
      `${messages} message(s) anonymized`;

    // "Complete" is only honest when nothing was left behind. A sweep that ran
    // out of room still erased real data, so this is not an error — but it is
    // the line that says data past its retention window is still live, and it
    // must not read like the clean case.
    if (businessesSkipped > 0 || businessesPending > 0) {
      this.logger.warn(
        `Retention sweep incomplete: ${summary}; ${businessesPending} business(es) ` +
          `still have leads past their window, ${businessesSkipped} not swept at all`,
      );
      return;
    }
    this.logger.log(`Retention sweep complete: ${summary}`);
  }
}
