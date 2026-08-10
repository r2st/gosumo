import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bull';
import {
  RealtyVisitsProcessor,
  VISIT_REMINDER_OPERATION,
} from './realty-sitevisits.processor';
import { RealtyVisitsService } from './realty-sitevisits.service';
import type { realty_dead_letters } from '@prisma/client';
import { RealtyDlqService, ReplayHandler } from '../realty-hardening/realty-dlq.service';
import { VisitReminderJobData } from './realty-sitevisits.constants';

/**
 * Processor tests for the delayed visit-reminder queue.
 *
 * The processor's job is narrow but load-bearing: every reminder must run
 * through the DLQ wrapper with `swallow: true` so one bad reminder can never
 * wedge the worker, and the module must register a replayer so a dead-lettered
 * reminder can be re-fired by an operator.
 */

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const VISIT_ID = '00000000-0000-4000-a000-000000000020';

/** The registered replayer ignores the entry row; a stub keeps the call typed. */
const DLQ_ENTRY = {} as realty_dead_letters;

function makeJob(data: Partial<VisitReminderJobData> = {}): Job<VisitReminderJobData> {
  return {
    data: {
      businessId: BUSINESS_ID,
      visitId: VISIT_ID,
      minutesBefore: 1440,
      ...data,
    },
  } as Job<VisitReminderJobData>;
}

describe('RealtyVisitsProcessor', () => {
  let processor: RealtyVisitsProcessor;
  let visitsService: { fireReminder: jest.Mock };
  let dlq: { runWithRetry: jest.Mock; registerReplayer: jest.Mock };

  beforeEach(async () => {
    visitsService = { fireReminder: jest.fn().mockResolvedValue(undefined) };
    dlq = {
      // Faithful stand-in: invoke the wrapped operation like the real service.
      runWithRetry: jest.fn(async (_b, _meta, op: () => Promise<unknown>) => op()),
      registerReplayer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyVisitsProcessor,
        { provide: RealtyVisitsService, useValue: visitsService },
        { provide: RealtyDlqService, useValue: dlq },
      ],
    }).compile();

    processor = module.get(RealtyVisitsProcessor);
  });

  describe('handleReminder', () => {
    it('fires the reminder for the job tenant, visit and offset', async () => {
      await processor.handleReminder(makeJob({ minutesBefore: 120 }));

      expect(visitsService.fireReminder).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        120,
      );
    });

    it('routes the reminder through the DLQ wrapper with swallow enabled', async () => {
      await processor.handleReminder(makeJob());

      expect(dlq.runWithRetry).toHaveBeenCalledWith(
        BUSINESS_ID,
        {
          source: 'realty-sitevisits',
          operation: VISIT_REMINDER_OPERATION,
          payload: { visitId: VISIT_ID, minutesBefore: 1440 },
        },
        expect.any(Function),
        { swallow: true },
      );
    });

    it('does not reject when the underlying reminder keeps failing', async () => {
      // The real DLQ service captures and returns null when swallow is set.
      dlq.runWithRetry.mockResolvedValue(null);

      await expect(processor.handleReminder(makeJob())).resolves.toBeUndefined();
    });

    it('carries the offset into the dead-letter payload so a replay is exact', async () => {
      await processor.handleReminder(makeJob({ minutesBefore: 120 }));

      expect(dlq.runWithRetry.mock.calls[0][1].payload).toEqual({
        visitId: VISIT_ID,
        minutesBefore: 120,
      });
    });
  });

  describe('onModuleInit', () => {
    it('registers a replayer under the visit-reminder operation key', () => {
      processor.onModuleInit();

      expect(dlq.registerReplayer).toHaveBeenCalledWith(
        VISIT_REMINDER_OPERATION,
        expect.any(Function),
      );
      expect(VISIT_REMINDER_OPERATION).toBe('realty.visit.reminder');
    });

    it('re-fires the reminder when the registered replayer runs', async () => {
      processor.onModuleInit();
      const replayer = dlq.registerReplayer.mock.calls[0][1] as ReplayHandler;

      await replayer(BUSINESS_ID, { visitId: VISIT_ID, minutesBefore: 120 }, DLQ_ENTRY);

      expect(visitsService.fireReminder).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        120,
      );
    });

    it('coerces a stringified offset from a persisted DLQ payload', async () => {
      processor.onModuleInit();
      const replayer = dlq.registerReplayer.mock.calls[0][1] as ReplayHandler;

      // DLQ payloads round-trip through JSONB, so numbers may arrive as strings.
      await replayer(BUSINESS_ID, { visitId: VISIT_ID, minutesBefore: '1440' }, DLQ_ENTRY);

      expect(visitsService.fireReminder).toHaveBeenCalledWith(
        BUSINESS_ID,
        VISIT_ID,
        1440,
      );
    });

    it('propagates a replay failure so the DLQ row stays unresolved', async () => {
      processor.onModuleInit();
      const replayer = dlq.registerReplayer.mock.calls[0][1] as ReplayHandler;
      visitsService.fireReminder.mockRejectedValue(new Error('visit gone'));

      await expect(
        replayer(BUSINESS_ID, { visitId: VISIT_ID, minutesBefore: 120 }, DLQ_ENTRY),
      ).rejects.toThrow('visit gone');
    });
  });
});
