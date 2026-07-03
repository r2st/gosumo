import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RealtyIngestionController } from './realty-ingestion.controller';
import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyIvrService } from './realty-ivr.service';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { ChannelAdapterModule } from '../channel-adapter/channel-adapter.module';
import { PrismaService } from '../../common/services/prisma.service';
import { ParserHealthService } from './health/parser-health.service';
import { ParserHealthRepository } from './health/parser-health.repository';
import { ParserHealthProcessor } from './health/parser-health.processor';
import { ParserHealthController } from './health/parser-health.controller';
import {
  PARSER_HEALTH_QUEUE,
  PARSER_HEALTH_JOBS,
  PARSER_HEALTH_REPEAT_JOB_ID,
  PARSER_HEALTH_CRON,
} from './health/parser-health.constants';

/**
 * RealtyIngestionModule (GoSumo Realty, Phase 4) — the ingress for every
 * external lead source: Meta Leadgen webhooks, property-portal enquiry emails,
 * CSV bulk imports, Click-to-WhatsApp context, and IVR missed-calls.
 *
 * Mostly stateless — it owns no tenant table. It parses source-specific payloads
 * and delegates to `RealtyLeadsService.ingestLead` (imported via
 * RealtyLeadsModule) for the E.164 identity-merge and the `realty.lead.ingested`
 * event. The IVR bridge additionally sends the instant WhatsApp greeting via the
 * channel adapter (blueprint §5.1).
 *
 * Also hosts the **portal-parser health monitor** (Phase 5): a weekly BullMQ job
 * re-parses known-good sample emails to catch 99acres/MagicBricks/Housing.com
 * template drift before real leads are silently lost, persisting snapshots to the
 * platform-ops `realty_parser_health_checks` table and emitting
 * `realty.parser.degraded` on regression.
 */
@Module({
  imports: [
    RealtyLeadsModule,
    ChannelAdapterModule,
    BullModule.registerQueue({ name: PARSER_HEALTH_QUEUE }),
  ],
  controllers: [RealtyIngestionController, ParserHealthController],
  providers: [
    RealtyIngestionService,
    RealtyIvrService,
    ParserHealthService,
    ParserHealthRepository,
    ParserHealthProcessor,
    PrismaService,
  ],
  exports: [RealtyIngestionService, RealtyIvrService, ParserHealthService],
})
export class RealtyIngestionModule implements OnModuleInit {
  private readonly logger = new Logger(RealtyIngestionModule.name);

  constructor(
    @InjectQueue(PARSER_HEALTH_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Register the weekly parser-health check as a BullMQ repeatable job. Stable
   * jobId + clears any prior repeatable with a different schedule, so a redeploy
   * never accumulates duplicate schedules. Redis unavailability (tests/CI) must
   * never block boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.queue.getRepeatableJobs();
      await Promise.all(
        existing
          .filter(
            (job) =>
              job.id === PARSER_HEALTH_REPEAT_JOB_ID && job.cron !== PARSER_HEALTH_CRON,
          )
          .map((job) => this.queue.removeRepeatableByKey(job.key)),
      );
      await this.queue.add(
        PARSER_HEALTH_JOBS.WEEKLY_CHECK,
        {},
        {
          jobId: PARSER_HEALTH_REPEAT_JOB_ID,
          repeat: { cron: PARSER_HEALTH_CRON },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log(`Scheduled weekly portal-parser health check (${PARSER_HEALTH_CRON})`);
    } catch (err) {
      this.logger.warn(
        `Could not schedule parser health check: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
