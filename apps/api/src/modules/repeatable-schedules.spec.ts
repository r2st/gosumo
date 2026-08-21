/**
 * Repeatable-job bootstrap — shared contract across the modules that own a cron.
 *
 * Four modules register a recurring Bull job in `onModuleInit`:
 * ComplianceModule (weekly DPDPA retention sweep), RealtyIngestionModule
 * (weekly portal-parser health check), RealtyIntegrationsModule (nightly
 * Google Sheets export) and SlaModule (five-minute overdue-breach sweep).
 * They implement the same three-part contract, and none of them had a test:
 *
 *   1. register the job under a stable jobId, so redeploys converge instead of
 *      accumulating schedules;
 *   2. before registering, remove any repeatable carrying that jobId under a
 *      *different* cron — otherwise changing a schedule leaves the old one
 *      running forever alongside the new one, and the sweep fires twice;
 *   3. never let a scheduling failure abort boot. Redis is not guaranteed to be
 *      reachable at module-init time (CI, a cold start racing the container),
 *      and a throw here takes the whole API down over a background job.
 *
 * The modules are driven directly rather than through a Nest container: the
 * constructor takes only the queue, and the behaviour under test is entirely
 * inside `onModuleInit`.
 */

import { Logger } from '@nestjs/common';
import type { Queue } from 'bull';

import { ComplianceModule } from './compliance/compliance.module';
import {
  COMPLIANCE_JOBS,
  RETENTION_CRON,
  RETENTION_REPEAT_JOB_ID,
} from './compliance/compliance.constants';
import { RealtyIngestionModule } from './realty-ingestion/realty-ingestion.module';
import {
  PARSER_HEALTH_CRON,
  PARSER_HEALTH_JOBS,
  PARSER_HEALTH_REPEAT_JOB_ID,
} from './realty-ingestion/health/parser-health.constants';
import { RealtyIntegrationsModule } from './realty-integrations/realty-integrations.module';
import { SlaModule } from './sla/sla.module';
import {
  SLA_JOBS,
  SLA_SWEEP_CRON,
  SLA_SWEEP_REPEAT_JOB_ID,
} from './sla/sla.constants';
import {
  NIGHTLY_SHEETS_EXPORT_CRON,
  NIGHTLY_SHEETS_EXPORT_JOB_ID,
  REALTY_INTEGRATIONS_JOBS,
} from './realty-integrations/realty-integrations.constants';

interface RepeatableJob {
  id: string;
  key: string;
  cron: string;
}

interface FakeQueue {
  getRepeatableJobs: jest.Mock<Promise<RepeatableJob[]>, []>;
  removeRepeatableByKey: jest.Mock<Promise<void>, [string]>;
  add: jest.Mock<Promise<void>, [string, unknown, Record<string, unknown>]>;
}

const makeQueue = (existing: RepeatableJob[] = []): FakeQueue => ({
  getRepeatableJobs: jest.fn().mockResolvedValue(existing),
  removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
  add: jest.fn().mockResolvedValue(undefined),
});

/**
 * The scheduled modules, described by the only things that differ between them.
 * Driving them from one table keeps the contract single-sourced — another
 * scheduled module is one row, not another copy of these six tests.
 */
const SCHEDULED_MODULES = [
  {
    name: 'ComplianceModule',
    build: (queue: Queue) => new ComplianceModule(queue),
    jobId: RETENTION_REPEAT_JOB_ID,
    cron: RETENTION_CRON,
    jobName: COMPLIANCE_JOBS.RETENTION_SWEEP,
  },
  {
    name: 'RealtyIngestionModule',
    build: (queue: Queue) => new RealtyIngestionModule(queue),
    jobId: PARSER_HEALTH_REPEAT_JOB_ID,
    cron: PARSER_HEALTH_CRON,
    jobName: PARSER_HEALTH_JOBS.WEEKLY_CHECK,
  },
  {
    name: 'RealtyIntegrationsModule',
    build: (queue: Queue) => new RealtyIntegrationsModule(queue),
    jobId: NIGHTLY_SHEETS_EXPORT_JOB_ID,
    cron: NIGHTLY_SHEETS_EXPORT_CRON,
    jobName: REALTY_INTEGRATIONS_JOBS.NIGHTLY_SHEETS_EXPORT,
  },
  {
    name: 'SlaModule',
    build: (queue: Queue) => new SlaModule(queue),
    jobId: SLA_SWEEP_REPEAT_JOB_ID,
    cron: SLA_SWEEP_CRON,
    jobName: SLA_JOBS.BREACH_SWEEP,
  },
] as const;

describe('repeatable job scheduling (onModuleInit)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  describe.each(SCHEDULED_MODULES)('$name', ({ build, jobId, cron, jobName }) => {
    it('registers its repeatable job under a stable id', async () => {
      const queue = makeQueue();

      await build(queue as unknown as Queue).onModuleInit();

      expect(queue.add).toHaveBeenCalledWith(
        jobName,
        {},
        expect.objectContaining({
          jobId,
          repeat: { cron },
          removeOnComplete: true,
          // Failures are kept: a silently dropped failed sweep is how a
          // compliance job stops running without anyone noticing.
          removeOnFail: false,
        }),
      );
    });

    it('removes a stale repeatable whose cron no longer matches', async () => {
      const queue = makeQueue([
        { id: jobId, key: 'stale-key', cron: '0 0 1 1 *' },
      ]);

      await build(queue as unknown as Queue).onModuleInit();

      // Without this, changing a schedule leaves both the old and the new
      // repeatable live and the job fires on two cadences.
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
      expect(queue.add).toHaveBeenCalled();
    });

    it('leaves an already-correct repeatable in place', async () => {
      const queue = makeQueue([{ id: jobId, key: 'current-key', cron }]);

      await build(queue as unknown as Queue).onModuleInit();

      // Re-adding under the same jobId is idempotent, but tearing down a
      // correct schedule on every boot would drop jobs mid-window.
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });

    it('ignores repeatables belonging to other jobs', async () => {
      const queue = makeQueue([
        { id: 'someone-elses-job', key: 'other-key', cron: '0 0 1 1 *' },
      ]);

      await build(queue as unknown as Queue).onModuleInit();

      // The queue is shared; removing by cron mismatch alone would evict a
      // different module's schedule.
      expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
    });

    it('does not block boot when the queue is unreachable', async () => {
      const queue = makeQueue();
      queue.getRepeatableJobs.mockRejectedValue(new Error('Redis unavailable'));

      await expect(
        build(queue as unknown as Queue).onModuleInit(),
      ).resolves.toBeUndefined();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('survives a rejection that is not an Error', async () => {
      const queue = makeQueue();
      // ioredis and bull both surface non-Error rejections in some paths; the
      // handler stringifies rather than assuming `.message` exists.
      queue.add.mockRejectedValue('connection reset');

      await expect(
        build(queue as unknown as Queue).onModuleInit(),
      ).resolves.toBeUndefined();
    });
  });
});
