import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { DataExportRepository } from './data-export.repository';
import { ExportJobService } from './export-job.service';
import { ExportJobRepository } from './export-job.repository';
import { ExportJobProcessor } from './export-job.processor';
import { AuditLogService } from '../../common/services/audit-log.service';
import {
  EXPORT_EXPIRY_CRON,
  EXPORT_EXPIRY_REPEAT_JOB_ID,
  EXPORT_JOBS,
  EXPORT_QUEUE,
  EXPORT_RECOVERY_CRON,
  EXPORT_RECOVERY_REPEAT_JOB_ID,
} from './export-job.constants';

/**
 * DataExportModule — subject-access exports for a customer (DPDPA §11,
 * GDPR Art. 15), synchronous and as a downloadable archive.
 *
 * Reads across eight modules' tables, which is the one place the repository
 * rule bends: going through each owning service would mean nine round trips
 * and nine chances for a scope to be implied rather than stated, for a read
 * that is the worst possible place to get tenant isolation wrong. The reads
 * live in `DataExportRepository`, they are all `findMany`, and every one names
 * `business_id` — see that file's header.
 *
 * `AuditLogService` is provided locally, as `conversation` and `tenant` do: it
 * is a stateless writer over the globally-provided `PrismaService`.
 */
@Module({
  imports: [BullModule.registerQueue({ name: EXPORT_QUEUE })],
  controllers: [DataExportController],
  providers: [
    DataExportService,
    DataExportRepository,
    ExportJobService,
    ExportJobRepository,
    ExportJobProcessor,
    AuditLogService,
  ],
  exports: [DataExportService, ExportJobService],
})
export class DataExportModule implements OnModuleInit {
  private readonly logger = new Logger(DataExportModule.name);

  constructor(@InjectQueue(EXPORT_QUEUE) private readonly queue: Queue) {}

  /**
   * Register the expiry and recovery sweeps as repeatable jobs. Same shape as
   * the notification and retention sweeps: a stable jobId, prior repeatables on
   * a different schedule removed first so a redeploy replaces the schedule
   * rather than accumulating one, and Redis being unavailable (tests/CI) never
   * blocking boot.
   */
  async onModuleInit(): Promise<void> {
    await this.schedule(EXPORT_JOBS.EXPIRE, EXPORT_EXPIRY_REPEAT_JOB_ID, EXPORT_EXPIRY_CRON);
    await this.schedule(
      EXPORT_JOBS.RECOVER_STUCK,
      EXPORT_RECOVERY_REPEAT_JOB_ID,
      EXPORT_RECOVERY_CRON,
    );
  }

  private async schedule(name: string, jobId: string, cron: string): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter((job) => job.id === jobId && job.cron !== cron)
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        name,
        {},
        {
          jobId,
          repeat: { cron },
          removeOnComplete: true,
          // Kept on purpose, as on the other crons: a sweep that fails is the
          // only signal that archives are piling up unswept or unbuilt.
          removeOnFail: false,
        },
      );
      this.logger.log(`Scheduled ${name} (${cron})`);
    } catch (err) {
      this.logger.warn(
        `Could not schedule ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
