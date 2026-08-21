/**
 * The scheduled overdue-breach sweep.
 *
 * Breach detection is event-driven: a tracker is checked when `message.sent`
 * or `conversation.resolved` fires. The conversation nobody ever answers has
 * no such event, so for it the sweep *is* the detection rather than a backstop
 * — and before this, nothing called it. `POST /sla/breaches/sweep` existed but
 * is per-business and manual, so in practice an ignored conversation breached
 * its SLA and no breach row, no `sla.breached` and no escalation followed.
 *
 * What is asserted here is the platform-wide wrapper, because its failure modes
 * are the quiet ones:
 *
 *  - **One bad tenant must not stop the rest.** A sweep that aborts halfway
 *    leaves every tenant after it in the list undetected until the next tick —
 *    and if the failure is persistent, forever, always the same tenants.
 *  - **Truncation must be visible.** The enumeration is capped, so a backlog
 *    larger than the cap drains across ticks. Reporting "done" would make
 *    "we stopped looking" indistinguishable from "nothing left".
 *  - **Only tenants with work are visited**, which is what makes a five-minute
 *    cadence affordable.
 */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

import { SlaService } from './sla.service';
import { SlaRepository } from './sla.repository';
import { SlaProcessor } from './sla.processor';
import { SLA_SWEEP_CRON, SLA_SWEEP_MAX_BUSINESSES } from './sla.constants';

const BIZ_A = '00000000-0000-4000-a000-00000000000a';
const BIZ_B = '00000000-0000-4000-a000-00000000000b';

describe('SlaService.sweepAllBusinesses', () => {
  let service: SlaService;
  let repository: {
    findBusinessIdsWithOverdueTrackers: jest.Mock;
    findOverdueUnmetTrackers: jest.Mock;
    markBreachedBatch: jest.Mock;
    markEscalatedBatch: jest.Mock;
    findPolicyById: jest.Mock;
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  const tracker = (id: string, businessId: string) => ({
    id,
    business_id: businessId,
    conversation_id: `conv-${id}`,
    policy_id: 'pol-1',
    breach_type: 'FIRST_RESPONSE',
    target_minutes: 15,
    due_at: new Date('2026-01-01T00:00:00Z'),
    breached: false,
    breached_at: null,
    escalated: false,
    escalated_at: null,
    met_at: null,
  });

  beforeEach(async () => {
    repository = {
      findBusinessIdsWithOverdueTrackers: jest.fn().mockResolvedValue([]),
      findOverdueUnmetTrackers: jest.fn().mockResolvedValue([]),
      markBreachedBatch: jest.fn().mockResolvedValue(0),
      markEscalatedBatch: jest.fn().mockResolvedValue(0),
      findPolicyById: jest.fn().mockResolvedValue(null),
    };

    const module = await Test.createTestingModule({
      providers: [
        SlaService,
        { provide: SlaRepository, useValue: repository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(SlaService);
  });

  it('does nothing when no tenant has an overdue tracker', async () => {
    const result = await service.sweepAllBusinesses();

    expect(result).toEqual({ businesses: 0, swept: 0, failed: 0, truncated: false });
    expect(repository.findOverdueUnmetTrackers).not.toHaveBeenCalled();
  });

  it('visits only the tenants the enumeration returned', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue([BIZ_A, BIZ_B]);

    await service.sweepAllBusinesses();

    const visited = repository.findOverdueUnmetTrackers.mock.calls.map((c) => c[0] as string);
    expect(visited).toEqual([BIZ_A, BIZ_B]);
  });

  it('scopes every per-tenant sweep to that tenant', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue([BIZ_A, BIZ_B]);
    repository.findOverdueUnmetTrackers.mockImplementation((businessId: string) =>
      Promise.resolve([tracker(`t-${businessId}`, businessId)]),
    );

    await service.sweepAllBusinesses();

    for (const call of repository.markBreachedBatch.mock.calls) {
      const [businessId, ids] = call as [string, string[]];
      expect(ids).toEqual([`t-${businessId}`]);
    }
  });

  it('totals the trackers swept across tenants', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue([BIZ_A, BIZ_B]);
    repository.findOverdueUnmetTrackers
      .mockResolvedValueOnce([tracker('t1', BIZ_A), tracker('t2', BIZ_A)])
      .mockResolvedValueOnce([tracker('t3', BIZ_B)]);

    const result = await service.sweepAllBusinesses();

    expect(result).toMatchObject({ businesses: 2, swept: 3, failed: 0 });
  });

  it('continues past a tenant whose sweep throws, and counts it', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue([BIZ_A, BIZ_B]);
    repository.findOverdueUnmetTrackers
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValueOnce([tracker('t3', BIZ_B)]);

    const result = await service.sweepAllBusinesses();

    // The healthy tenant was still swept — the failure did not truncate the run.
    expect(result).toMatchObject({ businesses: 2, swept: 1, failed: 1 });
    expect(repository.findOverdueUnmetTrackers).toHaveBeenCalledTimes(2);
  });

  it('does not reject when every tenant fails', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue([BIZ_A, BIZ_B]);
    repository.findOverdueUnmetTrackers.mockRejectedValue(new Error('down'));

    await expect(service.sweepAllBusinesses()).resolves.toMatchObject({ failed: 2, swept: 0 });
  });

  it('reports truncation when the tenant list fills the cap', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue(
      Array.from({ length: SLA_SWEEP_MAX_BUSINESSES }, (_, i) => `biz-${i}`),
    );

    const result = await service.sweepAllBusinesses();

    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation one tenant below the cap', async () => {
    repository.findBusinessIdsWithOverdueTrackers.mockResolvedValue(
      Array.from({ length: SLA_SWEEP_MAX_BUSINESSES - 1 }, (_, i) => `biz-${i}`),
    );

    const result = await service.sweepAllBusinesses();

    expect(result.truncated).toBe(false);
  });

  it('bounds the tenant enumeration', async () => {
    await service.sweepAllBusinesses();

    expect(repository.findBusinessIdsWithOverdueTrackers).toHaveBeenCalledWith(
      expect.any(Date),
      SLA_SWEEP_MAX_BUSINESSES,
    );
  });
});

describe('SLA_SWEEP_CRON', () => {
  it('runs often enough to be the detection path, not an hourly backstop', () => {
    // The sweep is how a never-answered conversation is detected at all, so the
    // interval is the resolution of the breach clock: a 15-minute SLA swept
    // hourly reports breaches up to an hour late.
    expect(SLA_SWEEP_CRON).toBe('*/5 * * * *');
  });
});

describe('SlaProcessor', () => {
  let processor: SlaProcessor;
  let sweepAllBusinesses: jest.Mock;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let debug: jest.SpyInstance;

  beforeEach(() => {
    sweepAllBusinesses = jest.fn().mockResolvedValue({
      businesses: 0,
      swept: 0,
      failed: 0,
      truncated: false,
    });
    processor = new SlaProcessor({ sweepAllBusinesses } as unknown as SlaService);

    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the quiet tick at debug', async () => {
    // 288 ticks a day. At `log` this would bury every line that matters.
    await processor.handleBreachSweep();

    expect(debug).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a clean sweep at log', async () => {
    sweepAllBusinesses.mockResolvedValue({
      businesses: 2,
      swept: 3,
      failed: 0,
      truncated: false,
    });

    await processor.handleBreachSweep();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('3 tracker(s)'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when a tenant failed, because its breaches are still unmarked', async () => {
    sweepAllBusinesses.mockResolvedValue({
      businesses: 2,
      swept: 1,
      failed: 1,
      truncated: false,
    });

    await processor.handleBreachSweep();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 business(es) failed'));
    expect(log).not.toHaveBeenCalled();
  });

  it('warns when the tenant list was capped', async () => {
    sweepAllBusinesses.mockResolvedValue({
      businesses: 200,
      swept: 40,
      failed: 0,
      truncated: true,
    });

    await processor.handleBreachSweep();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capped'));
  });
});
