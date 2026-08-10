import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyHardeningModule } from '../realty-hardening/realty-hardening.module';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ComplianceRepository } from './compliance.repository';
import { ConsentService } from './consent.service';
import { ComplianceNoticeService } from './compliance-notice.service';
import { RetentionService } from './retention.service';
import { RetentionProcessor } from './retention.processor';
import {
  COMPLIANCE_QUEUE,
  COMPLIANCE_JOBS,
  RETENTION_CRON,
  RETENTION_REPEAT_JOB_ID,
} from './compliance.constants';

/**
 * ComplianceModule — the DPDPA compliance surface for GoSumo Realty (plan §21).
 *
 * Owns `consent_logs` + `realty_compliance_settings`, and the data-principal
 * rights over `realty_leads`/`messages` (access, correction, erasure). Records
 * consent at first contact + exchange/marketing opt-in, cascades opt-out to the
 * ledger, injects the first-contact notice into the AI's first message
 * ({@link ComplianceNoticeService}, exported for the realty AI loop), and runs a
 * weekly retention sweep on the `compliance` Bull queue (registered here, Redis
 * configured globally in app.module.ts).
 */
@Module({
  imports: [
    RealtyHardeningModule,
    BullModule.registerQueue({ name: COMPLIANCE_QUEUE }),
  ],
  controllers: [ComplianceController],
  providers: [
    ComplianceService,
    ComplianceRepository,
    ConsentService,
    ComplianceNoticeService,
    RetentionService,
    RetentionProcessor,
    PrismaService,
  ],
  exports: [ComplianceService, ConsentService, ComplianceNoticeService],
})
export class ComplianceModule implements OnModuleInit {
  private readonly logger = new Logger(ComplianceModule.name);

  constructor(@InjectQueue(COMPLIANCE_QUEUE) private readonly queue: Queue) {}

  /**
   * Register the weekly retention sweep as a BullMQ repeatable job. Uses a stable
   * jobId and clears any prior repeatable with a different schedule first, so a
   * redeploy never accumulates duplicate schedules.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter((job) => job.id === RETENTION_REPEAT_JOB_ID && job.cron !== RETENTION_CRON)
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        COMPLIANCE_JOBS.RETENTION_SWEEP,
        {},
        {
          jobId: RETENTION_REPEAT_JOB_ID,
          repeat: { cron: RETENTION_CRON },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log(`Scheduled weekly DPDPA retention sweep (${RETENTION_CRON})`);
    } catch (err) {
      // Redis may be unavailable in some contexts (tests/CI) — never block boot.
      this.logger.warn(
        `Could not schedule retention sweep: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
