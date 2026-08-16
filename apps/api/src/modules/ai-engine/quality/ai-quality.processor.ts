import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { AI_QUALITY_JOBS, AI_QUALITY_QUEUE } from './ai-quality.constants';
import { AiQualityService } from './ai-quality.service';

/**
 * AiQualityProcessor — drives the hourly rollup.
 *
 * Deliberately does **not** swallow. A rollup that fails must reach Bull so it
 * retries and, if it keeps failing, logs at ERROR through `QueueTelemetryService`
 * — the rollup is the only thing that ever writes `ai_quality_metrics`, so a
 * silent failure shows up as a dashboard that simply stops moving, which reads
 * exactly like a quiet week.
 */
@Processor(AI_QUALITY_QUEUE)
export class AiQualityProcessor {
  private readonly logger = new Logger(AiQualityProcessor.name);

  constructor(private readonly service: AiQualityService) {}

  @Process(AI_QUALITY_JOBS.ROLLUP)
  async handleRollup(): Promise<void> {
    const summary = await this.service.runRollup();
    const written = summary.results.reduce((n, r) => n + r.rowsWritten, 0);
    this.logger.debug(`AI quality rollup tick wrote ${written} row(s)`);
  }
}
