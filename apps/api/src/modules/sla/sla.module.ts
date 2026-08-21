import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';
import { SlaRepository } from './sla.repository';
import { SlaProcessor } from './sla.processor';
import {
  SLA_JOBS,
  SLA_QUEUE,
  SLA_SWEEP_CRON,
  SLA_SWEEP_REPEAT_JOB_ID,
} from './sla.constants';

/**
 * SlaModule — configurable SLA targets, breach detection, and escalation.
 */
@Module({
  imports: [BullModule.registerQueue({ name: SLA_QUEUE })],
  controllers: [SlaController],
  providers: [SlaService, SlaRepository, SlaProcessor],
  exports: [SlaService],
})
export class SlaModule implements OnModuleInit {
  private readonly logger = new Logger(SlaModule.name);

  constructor(@InjectQueue(SLA_QUEUE) private readonly queue: Queue) {}

  /**
   * Register the periodic overdue-breach sweep as a repeatable job.
   *
   * Same three-part contract as the other scheduled modules: a stable jobId so
   * redeploys converge, removal of any repeatable holding that id under a
   * different cron so a schedule change does not leave the old one running
   * alongside the new one, and a scheduling failure that never aborts boot —
   * Redis is not guaranteed reachable at module-init time, and taking the API
   * down over a background job is the worse outcome.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter((job) => job.id === SLA_SWEEP_REPEAT_JOB_ID && job.cron !== SLA_SWEEP_CRON)
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        SLA_JOBS.BREACH_SWEEP,
        {},
        {
          jobId: SLA_SWEEP_REPEAT_JOB_ID,
          repeat: { cron: SLA_SWEEP_CRON },
          removeOnComplete: true,
          // Kept on purpose: a failed sweep is the record that a tenant's
          // breaches went undetected. See the note in the other cron modules.
          removeOnFail: false,
        },
      );
      this.logger.log(`Scheduled SLA breach sweep (${SLA_SWEEP_CRON})`);
    } catch (err) {
      this.logger.warn(
        `Could not schedule SLA breach sweep: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
