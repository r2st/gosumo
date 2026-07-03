import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { RealtyIntelligenceService } from './realty-intelligence.service';
import {
  REALTY_INTELLIGENCE_QUEUE,
  REALTY_INTELLIGENCE_JOBS,
  NIGHTLY_AGGREGATES_JOB_ID,
  NIGHTLY_AGGREGATES_CRON,
  NightlyAggregatesJobData,
} from './realty-intelligence.constants';

/**
 * RealtyIntelligenceProcessor — drives the nightly corridor-aggregation run.
 *
 * On boot it registers a single repeatable job (cron 02:30 IST) using a stable
 * jobId so re-registering on every deploy never stacks duplicate schedules. The
 * handler rebuilds aggregates across all opted-in tenants. A failed run is
 * retried by the global BullMQ backoff and, if still failing, logged — a missed
 * nightly build just means yesterday's priors persist another day (non-fatal).
 */
@Processor(REALTY_INTELLIGENCE_QUEUE)
export class RealtyIntelligenceProcessor implements OnModuleInit {
  private readonly logger = new Logger(RealtyIntelligenceProcessor.name);

  constructor(
    @InjectQueue(REALTY_INTELLIGENCE_QUEUE) private readonly queue: Queue,
    private readonly service: RealtyIntelligenceService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        REALTY_INTELLIGENCE_JOBS.NIGHTLY_AGGREGATES,
        {} as NightlyAggregatesJobData,
        {
          repeat: { cron: NIGHTLY_AGGREGATES_CRON },
          jobId: NIGHTLY_AGGREGATES_JOB_ID,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
      this.logger.log(
        `Registered nightly intelligence aggregation (cron "${NIGHTLY_AGGREGATES_CRON}")`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to register nightly aggregation job: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Process(REALTY_INTELLIGENCE_JOBS.NIGHTLY_AGGREGATES)
  async handleNightly(job: Job<NightlyAggregatesJobData>): Promise<void> {
    const businessId = job.data?.businessId;
    this.logger.log(
      `Running nightly intelligence aggregation${businessId ? ` for ${businessId}` : ' (all opted-in tenants)'}`,
    );
    const result = await this.service.generateNightlyAggregates(new Date(), businessId);
    this.logger.log(
      `Nightly aggregation done: ${result.aggregateCount} rows / ${result.corridorCount} corridors / ` +
        `${result.businessCount} business(es)`,
    );
  }
}
