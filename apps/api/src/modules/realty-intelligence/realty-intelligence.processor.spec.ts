/**
 * The nightly aggregation processor.
 *
 * Two behaviours matter and neither is exercised anywhere else: the boot-time
 * registration must survive a Redis that is not ready (a throw here would take
 * the whole app down on start), and it must register under a stable job id so
 * a redeploy does not stack a second nightly schedule on top of the first.
 */
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { RealtyIntelligenceProcessor } from './realty-intelligence.processor';
import { RealtyIntelligenceService } from './realty-intelligence.service';
import {
  REALTY_INTELLIGENCE_JOBS,
  NIGHTLY_AGGREGATES_JOB_ID,
  NIGHTLY_AGGREGATES_CRON,
  NightlyAggregatesJobData,
} from './realty-intelligence.constants';

function makeProcessor() {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const service = {
    generateNightlyAggregates: jest.fn().mockResolvedValue({
      aggregateCount: 12,
      corridorCount: 3,
      businessCount: 2,
    }),
  };

  const processor = new RealtyIntelligenceProcessor(
    queue as unknown as Queue,
    service as unknown as RealtyIntelligenceService,
  );

  return { processor, queue, service };
}

function makeJob(data: NightlyAggregatesJobData | undefined): Job<NightlyAggregatesJobData> {
  return { data } as Job<NightlyAggregatesJobData>;
}

describe('RealtyIntelligenceProcessor', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('registers the nightly job on the configured cron', async () => {
      const { processor, queue } = makeProcessor();

      await processor.onModuleInit();

      expect(queue.add).toHaveBeenCalledWith(
        REALTY_INTELLIGENCE_JOBS.NIGHTLY_AGGREGATES,
        {},
        expect.objectContaining({ repeat: { cron: NIGHTLY_AGGREGATES_CRON } }),
      );
    });

    it('uses a stable job id so redeploys do not stack schedules', async () => {
      // BullMQ dedups repeatable jobs on jobId. A generated id would add a
      // second nightly run on every boot, and the aggregation would then run
      // once per deploy that machine has ever seen.
      const { processor, queue } = makeProcessor();

      await processor.onModuleInit();

      expect(queue.add.mock.calls[0]![2]).toMatchObject({
        jobId: NIGHTLY_AGGREGATES_JOB_ID,
      });
    });

    it('does not throw when the queue is unreachable at boot', async () => {
      // onModuleInit runs during bootstrap. Letting a Redis hiccup escape here
      // would stop the API from starting at all, to protect a job whose worst
      // failure is yesterday's priors lasting another day.
      const { processor, queue } = makeProcessor();
      queue.add.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(processor.onModuleInit()).resolves.toBeUndefined();
    });

    it('logs the registration failure with the reason', async () => {
      const { processor, queue } = makeProcessor();
      queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
      const error = jest.spyOn(Logger.prototype, 'error');

      await processor.onModuleInit();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    });

    it('logs a non-Error rejection without crashing on .message', async () => {
      const { processor, queue } = makeProcessor();
      queue.add.mockRejectedValue('redis down');
      const error = jest.spyOn(Logger.prototype, 'error');

      await processor.onModuleInit();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('redis down'));
    });
  });

  describe('handleNightly', () => {
    it('runs across every opted-in tenant when the job carries no businessId', async () => {
      const { processor, service } = makeProcessor();

      await processor.handleNightly(makeJob({}));

      expect(service.generateNightlyAggregates).toHaveBeenCalledWith(expect.any(Date), undefined);
    });

    it('scopes the run to one tenant when the job names one', async () => {
      const { processor, service } = makeProcessor();

      await processor.handleNightly(makeJob({ businessId: 'biz-1' }));

      expect(service.generateNightlyAggregates).toHaveBeenCalledWith(expect.any(Date), 'biz-1');
    });

    it('tolerates a job with no data payload at all', async () => {
      // Repeatable jobs restored from an older Redis payload can arrive
      // without `data`; reading `.businessId` off it must not throw.
      const { processor, service } = makeProcessor();

      await expect(processor.handleNightly(makeJob(undefined))).resolves.toBeUndefined();
      expect(service.generateNightlyAggregates).toHaveBeenCalledWith(expect.any(Date), undefined);
    });

    it('reports the row, corridor, and business counts of the run', async () => {
      const { processor } = makeProcessor();
      const log = jest.spyOn(Logger.prototype, 'log');

      await processor.handleNightly(makeJob({}));

      expect(log).toHaveBeenCalledWith(expect.stringContaining('12'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('3 corridors'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('2 business(es)'));
    });

    it('lets a failed run reject, so BullMQ retries it', async () => {
      // The global queue config gives this three attempts with backoff.
      // Swallowing the error here would silently skip the night's rebuild.
      const { processor, service } = makeProcessor();
      service.generateNightlyAggregates.mockRejectedValue(new Error('aggregation failed'));

      await expect(processor.handleNightly(makeJob({}))).rejects.toThrow('aggregation failed');
    });
  });
});
