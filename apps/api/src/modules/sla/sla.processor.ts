import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';

import { SlaService } from './sla.service';
import { SLA_JOBS, SLA_QUEUE } from './sla.constants';

/**
 * SlaProcessor — consumes the periodic overdue-breach sweep.
 *
 * Holds no logic; delegates to {@link SlaService.sweepAllBusinesses} so the
 * scheduled path and a manual trigger exercise the same code.
 */
@Processor(SLA_QUEUE)
export class SlaProcessor {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(private readonly sla: SlaService) {}

  @Process(SLA_JOBS.BREACH_SWEEP)
  async handleBreachSweep(): Promise<void> {
    const { businesses, swept, failed, truncated } = await this.sla.sweepAllBusinesses();

    // The quiet case is the common one — this runs every five minutes and most
    // ticks find nothing. Logging it at `log` would bury the ticks that matter
    // under 288 lines a day saying nothing happened.
    if (businesses === 0) {
      this.logger.debug('SLA breach sweep: no tenant had an overdue tracker');
      return;
    }

    const summary = `${swept} tracker(s) across ${businesses} business(es)`;

    // A tenant whose sweep threw still has unmarked breaches, and a truncated
    // enumeration means more are waiting. Neither is an error — the next tick
    // retries both — but neither may read like the clean case.
    if (failed > 0 || truncated) {
      this.logger.warn(
        `SLA breach sweep incomplete: ${summary}; ${failed} business(es) failed` +
          (truncated ? ', and the tenant list was capped' : ''),
      );
      return;
    }

    this.logger.log(`SLA breach sweep: ${summary}`);
  }
}
