import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ParserHealthService } from './parser-health.service';
import { PARSER_HEALTH_QUEUE, PARSER_HEALTH_JOBS } from './parser-health.constants';

/**
 * ParserHealthProcessor — consumes the weekly portal-parser health probe off the
 * `realty-parser-health` queue. Delegates to {@link ParserHealthService.runCheck}
 * so the same path is exercised by unit tests and a manual trigger.
 */
@Processor(PARSER_HEALTH_QUEUE)
export class ParserHealthProcessor {
  private readonly logger = new Logger(ParserHealthProcessor.name);

  constructor(private readonly health: ParserHealthService) {}

  @Process(PARSER_HEALTH_JOBS.WEEKLY_CHECK)
  async handleWeeklyCheck(): Promise<void> {
    this.logger.log('Running weekly portal-parser health check');
    const reports = await this.health.runCheck();
    const degraded = reports.filter((r) => r.status !== 'HEALTHY').length;
    this.logger.log(
      `Weekly parser health check complete: ${reports.length} portal(s), ${degraded} degraded/failed`,
    );
  }
}
