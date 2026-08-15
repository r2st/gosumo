/**
 * WebhookDlqProcessor unit tests.
 *
 * The processor is thin on purpose — the retry state machine lives in the
 * service — so what is worth testing is the boundary behaviour a thin adapter
 * usually gets wrong:
 *
 *   - It must **not** rethrow. Bull's own retry is deliberately not in play:
 *     the attempt budget and the backoff live in the DB row, and a second
 *     retry engine layered on top would spend six attempts in seconds.
 *   - Boot must survive a queue that refuses the repeatable sweep. A missing
 *     sweep degrades recovery to "whatever Redis delivered"; it must not stop
 *     the app from starting.
 *   - The sweep is registered under a stable job id, or every deploy stacks
 *     another copy of the same schedule.
 */

import { WebhookDlqProcessor } from './webhook-dlq.processor';
import {
  WEBHOOK_DLQ_JOBS,
  WEBHOOK_DLQ_SWEEP_CRON,
  WEBHOOK_DLQ_SWEEP_JOB_ID,
} from './webhook-dlq.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const ENTRY_ID = '00000000-0000-4000-b000-000000000001';

function build() {
  const queue = {
    add: jest.fn(async () => ({ id: 'job-1' })),
    getRepeatableJobs: jest.fn(async () => [] as { key: string; id: string; cron: string }[]),
    removeRepeatableByKey: jest.fn(async () => undefined),
  };
  const dlq = {
    runRetry: jest.fn(async () => ({ status: 'REPLAYED' as const, entry: {} })),
    sweepDue: jest.fn(async () => 0),
  };
  const processor = new WebhookDlqProcessor(queue as never, dlq as never);
  return { processor, queue, dlq };
}

describe('WebhookDlqProcessor.onModuleInit', () => {
  it('registers the recovery sweep under a stable id', async () => {
    const { processor, queue } = build();

    await processor.onModuleInit();

    expect(queue.add).toHaveBeenCalledWith(
      WEBHOOK_DLQ_JOBS.SWEEP,
      {},
      expect.objectContaining({
        repeat: { cron: WEBHOOK_DLQ_SWEEP_CRON },
        jobId: WEBHOOK_DLQ_SWEEP_JOB_ID,
      }),
    );
  });

  it('boots even when the queue refuses the registration', async () => {
    const { processor, queue } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));

    await expect(processor.onModuleInit()).resolves.toBeUndefined();
  });

  // A stable jobId only dedupes an *unchanged* schedule: Bull keys a repeatable
  // by (name, cron, jobId), so editing the cron registers a second one beside
  // the first and the old schedule fires forever. Two live sweeps means
  // `sweepDue()` runs twice and re-enqueues the same due entries — duplicate
  // delivery attempts against a budget the DB row already bounds.
  it('removes a prior sweep left behind under a different cron', async () => {
    const { processor, queue } = build();
    queue.getRepeatableJobs.mockResolvedValue([
      { key: 'stale-key', id: WEBHOOK_DLQ_SWEEP_JOB_ID, cron: '0 0 * * *' },
    ]);

    await processor.onModuleInit();

    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('leaves the current schedule and unrelated repeatables alone', async () => {
    const { processor, queue } = build();
    queue.getRepeatableJobs.mockResolvedValue([
      { key: 'current-key', id: WEBHOOK_DLQ_SWEEP_JOB_ID, cron: WEBHOOK_DLQ_SWEEP_CRON },
      { key: 'someone-elses', id: 'another-job', cron: '0 3 * * *' },
    ]);

    await processor.onModuleInit();

    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('still boots when the stale-schedule cleanup itself fails', async () => {
    const { processor, queue } = build();
    queue.getRepeatableJobs.mockRejectedValue(new Error('redis down'));

    await expect(processor.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('WebhookDlqProcessor.handleRetry', () => {
  it('delegates to the service with the job’s tenant and entry', async () => {
    const { processor, dlq } = build();

    await processor.handleRetry({
      data: { deadLetterId: ENTRY_ID, businessId: BUSINESS_ID },
    } as never);

    expect(dlq.runRetry).toHaveBeenCalledWith(BUSINESS_ID, ENTRY_ID);
  });

  it('passes a null tenant through for a platform-level entry', async () => {
    const { processor, dlq } = build();

    await processor.handleRetry({
      data: { deadLetterId: ENTRY_ID, businessId: null },
    } as never);

    expect(dlq.runRetry).toHaveBeenCalledWith(null, ENTRY_ID);
  });

  it('drops a malformed job instead of calling the service with an empty id', async () => {
    const { processor, dlq } = build();

    await processor.handleRetry({ data: undefined } as never);

    expect(dlq.runRetry).not.toHaveBeenCalled();
  });

  it('does not rethrow, so Bull never runs a second retry engine on top', async () => {
    const { processor, dlq } = build();
    dlq.runRetry.mockRejectedValueOnce(new Error('entry vanished'));

    await expect(
      processor.handleRetry({
        data: { deadLetterId: ENTRY_ID, businessId: BUSINESS_ID },
      } as never),
    ).resolves.toBeUndefined();
  });
});

describe('WebhookDlqProcessor.handleSweep', () => {
  it('runs the recovery sweep', async () => {
    const { processor, dlq } = build();

    await processor.handleSweep();

    expect(dlq.sweepDue).toHaveBeenCalled();
  });

  it('swallows a sweep failure so the repeatable job keeps its schedule', async () => {
    const { processor, dlq } = build();
    dlq.sweepDue.mockRejectedValueOnce(new Error('db down'));

    await expect(processor.handleSweep()).resolves.toBeUndefined();
  });
});
