import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { ExportJobService } from './export-job.service';
import { BuildArchiveJobData, EXPORT_JOBS, EXPORT_QUEUE } from './export-job.constants';

/**
 * ExportJobProcessor — consumes the `data-export` Bull queue.
 *
 * No business logic; every handler delegates so the same paths the unit tests
 * cover are the ones that run. All three let exceptions escape — none of them
 * carries retry bookkeeping of its own, so Bull's retries and
 * `QueueTelemetryService` are the error boundary. A handler that swallowed
 * would mark the job complete and leave the failure with no trace at all.
 */
@Processor(EXPORT_QUEUE)
export class ExportJobProcessor {
  private readonly logger = new Logger(ExportJobProcessor.name);

  constructor(private readonly exports: ExportJobService) {}

  @Process(EXPORT_JOBS.BUILD)
  async handleBuild(job: Job<BuildArchiveJobData>): Promise<void> {
    const { businessId, jobId } = job.data;
    this.logger.debug(`Building export archive ${jobId}`);
    await this.exports.buildArchive(businessId, jobId);
  }

  /** Cross-tenant sweep — carries no job data; the tenants come from the rows. */
  @Process(EXPORT_JOBS.EXPIRE)
  async handleExpire(): Promise<void> {
    await this.exports.expireArchives();
  }

  /** Cross-tenant sweep for builds that never reached Redis. */
  @Process(EXPORT_JOBS.RECOVER_STUCK)
  async handleRecoverStuck(): Promise<void> {
    await this.exports.recoverStuck();
  }
}
