/**
 * The stuck-notification sweep is only a backstop if it is actually scheduled,
 * and a repeatable job is easy to get subtly wrong: a schedule change that
 * leaves the old cron running alongside the new one, or a Redis outage at boot
 * that takes the whole process down with it. These pin both.
 */

import { NotificationModule } from './notification.module';
import { NotificationProcessor } from './notification.processor';
import { NotificationService } from './notification.service';
import { NotificationSettingsService } from './settings/notification-settings.service';
import { OperatorAlertService } from './alerts/operator-alert.service';
import {
  NOTIFICATION_JOBS,
  STUCK_RECOVERY_CRON,
  STUCK_RECOVERY_REPEAT_JOB_ID,
} from './notification.constants';
import {
  ALERT_RELEASE_CRON,
  ALERT_RELEASE_JOB,
  ALERT_RELEASE_REPEAT_JOB_ID,
} from './alerts/operator-alert.constants';
import {
  DIGEST_SWEEP_CRON,
  DIGEST_SWEEP_JOB,
  DIGEST_SWEEP_REPEAT_JOB_ID,
} from './settings/notification-settings.constants';

type QueueMock = {
  add: jest.Mock;
  getRepeatableJobs: jest.Mock;
  removeRepeatableByKey: jest.Mock;
};

function makeQueue(existing: Array<{ id: string; cron: string; key: string }> = []): QueueMock {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    getRepeatableJobs: jest.fn().mockResolvedValue(existing),
    removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
  };
}

describe('NotificationModule — sweep scheduling', () => {
  it('registers the sweep under a stable job id on the declared cron', async () => {
    const queue = makeQueue();

    await new NotificationModule(queue as never).onModuleInit();

    expect(queue.add).toHaveBeenCalledWith(
      NOTIFICATION_JOBS.RECOVER_STUCK,
      {},
      expect.objectContaining({
        jobId: STUCK_RECOVERY_REPEAT_JOB_ID,
        repeat: { cron: STUCK_RECOVERY_CRON },
      }),
    );
  });

  it('keeps failed sweeps in Redis — an unswept backlog has no other signal', async () => {
    const queue = makeQueue();

    await new NotificationModule(queue as never).onModuleInit();

    const opts = queue.add.mock.calls[0]![2] as { removeOnFail: boolean };
    expect(opts.removeOnFail).toBe(false);
  });

  it('drops a prior repeatable on a different schedule, so a redeploy replaces rather than doubles', async () => {
    const queue = makeQueue([
      { id: STUCK_RECOVERY_REPEAT_JOB_ID, cron: '0 * * * *', key: 'stale-key' },
    ]);

    await new NotificationModule(queue as never).onModuleInit();

    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
  });

  it('leaves an identical existing schedule and every other queue\'s job alone', async () => {
    const queue = makeQueue([
      { id: STUCK_RECOVERY_REPEAT_JOB_ID, cron: STUCK_RECOVERY_CRON, key: 'current-key' },
      { id: 'some-other-repeatable', cron: '0 3 * * *', key: 'other-key' },
    ]);

    await new NotificationModule(queue as never).onModuleInit();

    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('registers the digest and alert-release sweeps alongside it', async () => {
    // Three independent schedules on one queue. A new one added to
    // `onModuleInit` without its own case here is a sweep nobody notices is
    // unregistered — the failure mode is silence, not an error.
    const queue = makeQueue();

    await new NotificationModule(queue as never).onModuleInit();

    expect(queue.add).toHaveBeenCalledWith(
      DIGEST_SWEEP_JOB,
      {},
      expect.objectContaining({
        jobId: DIGEST_SWEEP_REPEAT_JOB_ID,
        repeat: { cron: DIGEST_SWEEP_CRON },
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      ALERT_RELEASE_JOB,
      {},
      expect.objectContaining({
        jobId: ALERT_RELEASE_REPEAT_JOB_ID,
        repeat: { cron: ALERT_RELEASE_CRON },
      }),
    );
  });

  it('still registers the later schedules when an earlier one fails', async () => {
    // Registered independently rather than in one `Promise.all`: Redis being
    // half-available must not cost the alert release sweep its schedule.
    const queue = makeQueue();
    queue.getRepeatableJobs
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue([]);

    await new NotificationModule(queue as never).onModuleInit();

    expect(queue.add).toHaveBeenCalledWith(
      ALERT_RELEASE_JOB,
      {},
      expect.objectContaining({ jobId: ALERT_RELEASE_REPEAT_JOB_ID }),
    );
  });

  it('never blocks boot when Redis is unavailable', async () => {
    const queue = makeQueue();
    queue.getRepeatableJobs.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(new NotificationModule(queue as never).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('NotificationProcessor — sweep job', () => {
  it('runs the sweep and lets a failure reach Bull', async () => {
    const service = { recoverStuck: jest.fn().mockResolvedValue(undefined) };
    const processor = new NotificationProcessor(
      service as unknown as NotificationService,
      { sweepDueDigests: jest.fn() } as unknown as NotificationSettingsService,
      { sweepDeferred: jest.fn() } as unknown as OperatorAlertService,
    );

    await processor.handleRecoverStuck();
    expect(service.recoverStuck).toHaveBeenCalled();

    // Unlike `dispatch`, this job owns no retry bookkeeping of its own —
    // swallowing here would mark it complete and lose the only error signal.
    service.recoverStuck.mockRejectedValue(new Error('db down'));
    await expect(processor.handleRecoverStuck()).rejects.toThrow('db down');
  });
});
