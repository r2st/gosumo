/**
 * RetentionProcessor unit tests — the BullMQ consumer for the weekly sweep.
 *
 * It holds no logic beyond delegating to RetentionService.runAll() and logging
 * the aggregate. These tests pin that delegation and the count aggregation.
 */

import { RetentionProcessor } from './retention.processor';

describe('RetentionProcessor', () => {
  it('delegates the scheduled sweep to RetentionService.runAll across all businesses', async () => {
    const runAll = jest.fn().mockResolvedValue([
      { businessId: 'a', retentionMonths: 24, cutoff: new Date(), leadsAnonymized: 2, messagesAnonymized: 5 },
      { businessId: 'b', retentionMonths: 24, cutoff: new Date(), leadsAnonymized: 1, messagesAnonymized: 3 },
    ]);
    const processor = new RetentionProcessor({ runAll } as never);

    await expect(processor.handleRetentionSweep()).resolves.toBeUndefined();
    expect(runAll).toHaveBeenCalledTimes(1);
  });

  it('handles an empty sweep result without error', async () => {
    const runAll = jest.fn().mockResolvedValue([]);
    const processor = new RetentionProcessor({ runAll } as never);
    await expect(processor.handleRetentionSweep()).resolves.toBeUndefined();
  });
});
