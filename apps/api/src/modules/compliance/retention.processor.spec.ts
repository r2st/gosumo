/**
 * RetentionProcessor unit tests — the BullMQ consumer for the weekly sweep.
 *
 * It holds no logic beyond delegating to RetentionService.runAll() and logging
 * the aggregate. These tests pin that delegation, the count aggregation, and
 * the one thing the log line has to get right: a sweep that left data past its
 * retention window must not report itself as complete.
 */

import { Logger } from '@nestjs/common';
import { RetentionProcessor } from './retention.processor';

/** A summary as RetentionService.runAll returns it. */
function summary(over: Record<string, unknown> = {}) {
  return {
    results: [
      { businessId: 'a', retentionMonths: 24, cutoff: new Date(), leadsAnonymized: 2, messagesAnonymized: 5, leadsPending: false },
      { businessId: 'b', retentionMonths: 24, cutoff: new Date(), leadsAnonymized: 1, messagesAnonymized: 3, leadsPending: false },
    ],
    businessesSkipped: 0,
    businessesPending: 0,
    ...over,
  };
}

describe('RetentionProcessor', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('delegates the scheduled sweep to RetentionService.runAll across all businesses', async () => {
    const runAll = jest.fn().mockResolvedValue(summary());
    const processor = new RetentionProcessor({ runAll } as never);

    await expect(processor.handleRetentionSweep()).resolves.toBeUndefined();
    expect(runAll).toHaveBeenCalledTimes(1);
  });

  it('handles an empty sweep result without error', async () => {
    const runAll = jest.fn().mockResolvedValue({
      results: [],
      businessesSkipped: 0,
      businessesPending: 0,
    });
    const processor = new RetentionProcessor({ runAll } as never);
    await expect(processor.handleRetentionSweep()).resolves.toBeUndefined();
  });

  it('reports a fully drained sweep as complete', async () => {
    const runAll = jest.fn().mockResolvedValue(summary());
    await new RetentionProcessor({ runAll } as never).handleRetentionSweep();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('complete'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns instead of claiming completion when a business still has leads over its window', async () => {
    const runAll = jest.fn().mockResolvedValue(summary({ businessesPending: 1 }));
    await new RetentionProcessor({ runAll } as never).handleRetentionSweep();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
    // The whole regression: this used to log "complete" either way, so the one
    // line an operator greps for said the window was being honoured when it
    // was not.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('complete'));
  });

  it('warns when the run ran out of time before reaching every business', async () => {
    const runAll = jest.fn().mockResolvedValue(summary({ businessesSkipped: 3 }));
    await new RetentionProcessor({ runAll } as never).handleRetentionSweep();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 not swept at all'));
  });

  /**
   * The sweep must fail loudly. Swallowing here would resolve the job, Bull
   * would mark it complete, and the weekly DPDPA sweep would stop running with
   * the only trace being an absence — no retry, no exhausted-retry line from
   * `QueueTelemetryService`, and data past its retention window still live.
   * This is the same reason `removeOnFail: false` is set on the cron.
   */
  it('lets a failed sweep reach Bull rather than reporting a clean run', async () => {
    const runAll = jest.fn().mockRejectedValue(new Error('anonymization failed'));
    const processor = new RetentionProcessor({ runAll } as never);

    await expect(processor.handleRetentionSweep()).rejects.toThrow('anonymization failed');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('complete'));
  });
});
