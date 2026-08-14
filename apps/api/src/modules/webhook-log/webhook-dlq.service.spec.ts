/**
 * WebhookDlqService — the recovery path for inbound webhooks whose handler threw.
 *
 * What these tests pin down is the reason the module exists: `webhook_events`
 * dedupes on `(source, external_id)`, so once a delivery is recorded the
 * gateway's own redelivery is discarded as a duplicate. A handler that threw
 * had, before this, no second chance at all. So the assertions here are about
 * the schedule (does attempt N wait the right amount?), the budget (does it
 * ever stop?), and the failure modes of the machinery itself (a DB that
 * refuses the write, a queue that refuses the job) — because a dead-letter
 * queue that throws inside a webhook handler is worse than none.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DeadLetterStatus } from '@prisma/client';
import type { webhook_dead_letters } from '@prisma/client';
import { WebhookDlqService } from './webhook-dlq.service';
import {
  WEBHOOK_DLQ_EVENTS,
  WEBHOOK_DLQ_JOBS,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_RETRY_MAX_BACKOFF_MS,
  webhookRetryBackoffMs,
} from './webhook-dlq.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const ENTRY_ID = '00000000-0000-4000-b000-000000000001';
const NOW = new Date('2026-08-14T10:00:00.000Z');

function makeEntry(overrides: Partial<webhook_dead_letters> = {}): webhook_dead_letters {
  return {
    id: ENTRY_ID,
    business_id: BUSINESS_ID,
    webhook_event_id: null,
    source: 'RAZORPAY',
    event_type: 'payment.captured',
    external_id: 'payment.captured_pay_123',
    payload: { event: 'payment.captured' },
    headers: {},
    error_message: 'gateway timeout',
    error_stack: null,
    attempts: 1,
    max_attempts: 6,
    status: DeadLetterStatus.PENDING,
    next_retry_at: new Date('2026-08-14T10:00:30.000Z'),
    last_attempt_at: NOW,
    replayed_at: null,
    resolved_at: null,
    resolution: null,
    correlation_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as webhook_dead_letters;
}

interface Harness {
  service: WebhookDlqService;
  repository: {
    capture: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    countByStatus: jest.Mock;
    countPendingGlobal: jest.Mock;
    listDueGlobal: jest.Mock;
    update: jest.Mock;
  };
  emitter: { emit: jest.Mock };
  queue: { add: jest.Mock };
}

function build(): Harness {
  const repository = {
    capture: jest.fn(async (data: Record<string, unknown>) =>
      makeEntry({
        attempts: data.attempts as number,
        next_retry_at: data.nextRetryAt as Date,
        error_message: data.errorMessage as string,
        business_id: (data.businessId as string | null) ?? null,
      }),
    ),
    findById: jest.fn(async () => makeEntry()),
    list: jest.fn(async () => [makeEntry()]),
    countByStatus: jest.fn(async () => 0),
    countPendingGlobal: jest.fn(async () => 0),
    listDueGlobal: jest.fn(async () => []),
    update: jest.fn(async (_b: string | null, _id: string, data: Record<string, unknown>) =>
      makeEntry(data as Partial<webhook_dead_letters>),
    ),
  };
  const emitter = { emit: jest.fn() };
  const queue = { add: jest.fn(async () => ({ id: 'job-1' })) };

  const service = new WebhookDlqService(
    repository as never,
    emitter as never,
    queue as never,
  );
  return { service, repository, emitter, queue };
}

// ─────────────────────────────────────────────
// Backoff schedule
// ─────────────────────────────────────────────

describe('webhookRetryBackoffMs', () => {
  it('doubles the wait on each successive attempt', () => {
    expect(webhookRetryBackoffMs(1)).toBe(WEBHOOK_RETRY_BASE_MS);
    expect(webhookRetryBackoffMs(2)).toBe(WEBHOOK_RETRY_BASE_MS * 2);
    expect(webhookRetryBackoffMs(3)).toBe(WEBHOOK_RETRY_BASE_MS * 4);
    expect(webhookRetryBackoffMs(4)).toBe(WEBHOOK_RETRY_BASE_MS * 8);
  });

  it('caps the wait so a late attempt still lands within the hour', () => {
    expect(webhookRetryBackoffMs(20)).toBe(WEBHOOK_RETRY_MAX_BACKOFF_MS);
  });

  it('treats a nonsense attempt number as the first retry rather than overflowing', () => {
    // 2 ** 1e9 is Infinity, which would persist as an invalid `next_retry_at`
    // and park the entry forever.
    expect(webhookRetryBackoffMs(0)).toBe(WEBHOOK_RETRY_BASE_MS);
    expect(webhookRetryBackoffMs(-5)).toBe(WEBHOOK_RETRY_BASE_MS);
    expect(webhookRetryBackoffMs(1e9)).toBe(WEBHOOK_RETRY_MAX_BACKOFF_MS);
  });
});

// ─────────────────────────────────────────────
// Capture
// ─────────────────────────────────────────────

describe('WebhookDlqService.capture', () => {
  const delivery = {
    businessId: BUSINESS_ID,
    webhookEventId: 'evt-1',
    source: 'RAZORPAY',
    eventType: 'payment.captured',
    externalId: 'payment.captured_pay_123',
    payload: { event: 'payment.captured' },
  };

  it('records the failure as attempt 1 and schedules the first retry', async () => {
    const { service, repository, queue } = build();

    await service.capture(delivery, new Error('gateway timeout'), NOW);

    expect(repository.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        source: 'RAZORPAY',
        externalId: 'payment.captured_pay_123',
        errorMessage: 'gateway timeout',
        attempts: 1,
        nextRetryAt: new Date(NOW.getTime() + WEBHOOK_RETRY_BASE_MS),
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      WEBHOOK_DLQ_JOBS.RETRY,
      { deadLetterId: ENTRY_ID, businessId: BUSINESS_ID },
      expect.objectContaining({ delay: WEBHOOK_RETRY_BASE_MS, attempts: 1 }),
    );
  });

  it('lets Bull retry nothing on its own, so the DB row owns the budget', async () => {
    // Two retry engines would spend six attempts in seconds. The row's
    // `attempts`/`next_retry_at` is the only schedule.
    const { service, queue } = build();

    await service.capture(delivery, new Error('boom'), NOW);

    expect(queue.add.mock.calls[0]?.[2]).toMatchObject({ attempts: 1 });
  });

  it('announces the capture so anything watching webhook health hears it', async () => {
    const { service, emitter } = build();

    await service.capture(delivery, new Error('boom'), NOW);

    expect(emitter.emit).toHaveBeenCalledWith(
      WEBHOOK_DLQ_EVENTS.CAPTURED,
      expect.objectContaining({ businessId: BUSINESS_ID, source: 'RAZORPAY' }),
    );
  });

  it('accepts a delivery whose tenant could not be resolved', async () => {
    // A gateway webhook that failed before its payment row could be read has
    // no knowable business. Refusing it would drop exactly the events most
    // worth keeping.
    const { service, repository } = build();

    const entry = await service.capture(
      { ...delivery, businessId: null },
      new Error('db down'),
      NOW,
    );

    expect(repository.capture).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: null }),
    );
    expect(entry?.business_id).toBeNull();
  });

  it('swallows a DB failure instead of turning one lost event into a 500', async () => {
    // This runs inside a webhook handler's catch block. Throwing here makes
    // the gateway see a 500 and redeliver — into the dedupe wall.
    const { service, repository, queue } = build();
    repository.capture.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      service.capture(delivery, new Error('boom'), NOW),
    ).resolves.toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps the entry when the queue refuses the job, so the sweep can find it', async () => {
    const { service, queue } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));

    const entry = await service.capture(delivery, new Error('boom'), NOW);

    // The row was still written with a `next_retry_at`; sweepDue() is the
    // backstop for exactly this.
    expect(entry).not.toBeNull();
    expect(entry?.next_retry_at).toEqual(new Date(NOW.getTime() + WEBHOOK_RETRY_BASE_MS));
  });

  it('stringifies a non-Error throw rather than storing "[object Object]"', async () => {
    const { service, repository } = build();

    await service.capture(delivery, 'plain string failure', NOW);

    expect(repository.capture).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'plain string failure', errorStack: null }),
    );
  });
});

// ─────────────────────────────────────────────
// Retry
// ─────────────────────────────────────────────

describe('WebhookDlqService.runRetry', () => {
  it('replays through the registered handler and closes the entry out', async () => {
    const { service, repository, emitter } = build();
    const handler = jest.fn(async () => undefined);
    service.registerReplayer('RAZORPAY', handler);

    const outcome = await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(handler).toHaveBeenCalledWith(
      { event: 'payment.captured' },
      expect.objectContaining({ id: ENTRY_ID }),
    );
    expect(outcome.status).toBe('REPLAYED');
    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      ENTRY_ID,
      expect.objectContaining({
        status: DeadLetterStatus.REPLAYED,
        attempts: 2,
        next_retry_at: null,
      }),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      WEBHOOK_DLQ_EVENTS.REPLAYED,
      expect.objectContaining({ deadLetterId: ENTRY_ID, attempts: 2 }),
    );
  });

  it('matches the replayer case-insensitively', async () => {
    const { service } = build();
    const handler = jest.fn(async () => undefined);
    service.registerReplayer('razorpay', handler);

    await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(handler).toHaveBeenCalled();
  });

  it('reschedules with a doubled backoff when the handler throws again', async () => {
    const { service, repository, queue } = build();
    service.registerReplayer('RAZORPAY', async () => {
      throw new Error('still timing out');
    });

    const outcome = await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(outcome.status).toBe('RESCHEDULED');
    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      ENTRY_ID,
      expect.objectContaining({
        attempts: 2,
        error_message: 'still timing out',
        next_retry_at: new Date(NOW.getTime() + webhookRetryBackoffMs(2)),
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      WEBHOOK_DLQ_JOBS.RETRY,
      expect.anything(),
      expect.objectContaining({ delay: webhookRetryBackoffMs(2) }),
    );
  });

  it('discards once the attempt budget is spent, keeping the payload readable', async () => {
    const { service, repository, emitter, queue } = build();
    repository.findById.mockResolvedValueOnce(makeEntry({ attempts: 5, max_attempts: 6 }));
    service.registerReplayer('RAZORPAY', async () => {
      throw new Error('permanently broken');
    });

    const outcome = await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(outcome.status).toBe('DISCARDED');
    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      ENTRY_ID,
      expect.objectContaining({
        status: DeadLetterStatus.DISCARDED,
        attempts: 6,
        next_retry_at: null,
        resolution: 'auto-discarded after 6 attempts',
      }),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      WEBHOOK_DLQ_EVENTS.DISCARDED,
      expect.objectContaining({ attempts: 6 }),
    );
    // Nothing further is scheduled — that is what "discarded" has to mean.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('respects a per-entry max_attempts rather than a global constant', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(makeEntry({ attempts: 1, max_attempts: 2 }));
    service.registerReplayer('RAZORPAY', async () => {
      throw new Error('nope');
    });

    const outcome = await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(outcome.status).toBe('DISCARDED');
  });

  it('fails the attempt when no module owns the source, instead of spinning', async () => {
    // Rescheduling would retry against a gap only a deploy can close, burning
    // the budget on an error message nobody would ever read.
    const { service, repository } = build();

    const outcome = await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(outcome.status).toBe('RESCHEDULED');
    expect(outcome.error).toContain('No replayer registered');
    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      ENTRY_ID,
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it('skips an entry a duplicate job delivers twice', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(
      makeEntry({ status: DeadLetterStatus.REPLAYED }),
    );
    const handler = jest.fn(async () => undefined);
    service.registerReplayer('RAZORPAY', handler);

    const outcome = await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(outcome.status).toBe('SKIPPED');
    expect(handler).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('skips an entry an operator already resolved by hand', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(
      makeEntry({ status: DeadLetterStatus.RESOLVED }),
    );
    service.registerReplayer('RAZORPAY', jest.fn(async () => undefined));

    expect((await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW)).status).toBe('SKIPPED');
  });

  it('404s on an entry belonging to another business', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(null);

    await expect(service.runRetry(BUSINESS_ID, ENTRY_ID, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('carries the entry’s own tenant into the update, not the caller’s', async () => {
    // A platform-level entry (business_id null) is retried by the worker with
    // a null tenant; writing the caller's value would re-home the row.
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(makeEntry({ business_id: null }));
    service.registerReplayer('RAZORPAY', async () => undefined);

    await service.runRetry(null, ENTRY_ID, NOW);

    expect(repository.update).toHaveBeenCalledWith(null, ENTRY_ID, expect.anything());
  });

  it('tolerates a payload that is not an object', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(
      makeEntry({ payload: ['not', 'an', 'object'] as never }),
    );
    const handler = jest.fn(async () => undefined);
    service.registerReplayer('RAZORPAY', handler);

    await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(handler).toHaveBeenCalledWith({}, expect.anything());
  });
});

// ─────────────────────────────────────────────
// Recovery sweep
// ─────────────────────────────────────────────

describe('WebhookDlqService.sweepDue', () => {
  it('re-enqueues entries whose retry job never arrived', async () => {
    const { service, repository, queue } = build();
    repository.listDueGlobal.mockResolvedValueOnce([
      { id: 'a', business_id: BUSINESS_ID },
      { id: 'b', business_id: null },
    ]);

    expect(await service.sweepDue(NOW, 50)).toBe(2);
    expect(repository.listDueGlobal).toHaveBeenCalledWith(NOW, 50);
    expect(queue.add).toHaveBeenCalledWith(
      WEBHOOK_DLQ_JOBS.RETRY,
      { deadLetterId: 'b', businessId: null },
      expect.objectContaining({ delay: 0, jobId: 'sweep:b' }),
    );
  });

  it('reports only what it managed to enqueue', async () => {
    const { service, repository, queue } = build();
    repository.listDueGlobal.mockResolvedValueOnce([
      { id: 'a', business_id: BUSINESS_ID },
      { id: 'b', business_id: BUSINESS_ID },
    ]);
    queue.add.mockRejectedValueOnce(new Error('redis down'));

    expect(await service.sweepDue(NOW, 50)).toBe(1);
  });

  it('does nothing when no retry is overdue', async () => {
    const { service, queue } = build();

    expect(await service.sweepDue(NOW)).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Inspection / operator actions
// ─────────────────────────────────────────────

describe('WebhookDlqService inspection', () => {
  it('keeps captured payloads out of the list view', async () => {
    // Payloads carry customer PII and are large; the list is a triage screen.
    const { service } = build();

    const [row] = await service.list(BUSINESS_ID);

    expect(row).toMatchObject({ id: ENTRY_ID, source: 'RAZORPAY', attempts: 1 });
    expect(row).not.toHaveProperty('payload');
  });

  it('serialises timestamps as ISO strings, nulls included', async () => {
    const { service } = build();

    const [row] = await service.list(BUSINESS_ID);

    expect(row?.nextRetryAt).toBe('2026-08-14T10:00:30.000Z');
    expect(row?.replayedAt).toBeNull();
    expect(row?.createdAt).toBe(NOW.toISOString());
  });

  it('includes the payload on the single-entry view', async () => {
    const { service } = build();

    const entry = await service.get(BUSINESS_ID, ENTRY_ID);

    expect(entry.payload).toEqual({ event: 'payment.captured' });
    expect(entry.webhookEventId).toBeNull();
  });

  it('404s rather than returning another business’s entry', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(null);

    await expect(service.get(BUSINESS_ID, ENTRY_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reports counts alongside the sources that can actually be replayed', async () => {
    const { service, repository } = build();
    repository.countByStatus
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    service.registerReplayer('STRIPE', async () => undefined);
    service.registerReplayer('RAZORPAY', async () => undefined);

    expect(await service.stats(BUSINESS_ID)).toEqual({
      pending: 3,
      replayed: 2,
      resolved: 1,
      discarded: 0,
      sources: ['RAZORPAY', 'STRIPE'],
    });
  });

  it('exposes the platform-wide backlog as a bare count', async () => {
    const { service, repository } = build();
    repository.countPendingGlobal.mockResolvedValueOnce(17);

    expect(await service.pendingDepth()).toBe(17);
  });
});

describe('WebhookDlqService.replayNow', () => {
  it('runs the next attempt immediately and returns the outcome', async () => {
    const { service } = build();
    service.registerReplayer('RAZORPAY', async () => undefined);

    const result = await service.replayNow(BUSINESS_ID, ENTRY_ID);

    expect(result.status).toBe('REPLAYED');
    expect(result.error).toBeNull();
    expect(result.entry.id).toBe(ENTRY_ID);
  });

  it('surfaces the failure text when the replay throws again', async () => {
    const { service } = build();
    service.registerReplayer('RAZORPAY', async () => {
      throw new Error('order service unreachable');
    });

    const result = await service.replayNow(BUSINESS_ID, ENTRY_ID);

    expect(result.status).toBe('RESCHEDULED');
    expect(result.error).toBe('order service unreachable');
  });
});

describe('WebhookDlqService.resolve', () => {
  it('stops further retries when an operator closes an entry out', async () => {
    const { service, repository, emitter } = build();

    await service.resolve(BUSINESS_ID, ENTRY_ID, DeadLetterStatus.RESOLVED, 'fixed by hand');

    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      ENTRY_ID,
      expect.objectContaining({
        status: DeadLetterStatus.RESOLVED,
        resolution: 'fixed by hand',
        next_retry_at: null,
      }),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      WEBHOOK_DLQ_EVENTS.RESOLVED,
      expect.objectContaining({ status: DeadLetterStatus.RESOLVED }),
    );
  });

  it('stores a null note rather than the string "undefined"', async () => {
    const { service, repository } = build();

    await service.resolve(BUSINESS_ID, ENTRY_ID, DeadLetterStatus.DISCARDED);

    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      ENTRY_ID,
      expect.objectContaining({ resolution: null }),
    );
  });

  it('refuses a status that is not a closing one', async () => {
    // PENDING/REPLAYED are outcomes of the machine, not decisions a human makes.
    const { service, repository } = build();

    await expect(
      service.resolve(BUSINESS_ID, ENTRY_ID, DeadLetterStatus.PENDING),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('404s before writing anything when the entry is another business’s', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValueOnce(null);

    await expect(
      service.resolve(BUSINESS_ID, ENTRY_ID, DeadLetterStatus.RESOLVED),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('WebhookDlqService replayer registry', () => {
  it('lets a later registration replace an earlier one', async () => {
    const { service } = build();
    const first = jest.fn(async () => undefined);
    const second = jest.fn(async () => undefined);
    service.registerReplayer('RAZORPAY', first);
    service.registerReplayer('RAZORPAY', second);

    await service.runRetry(BUSINESS_ID, ENTRY_ID, NOW);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('lists registered sources in a stable order', () => {
    const { service } = build();
    service.registerReplayer('stripe', async () => undefined);
    service.registerReplayer('WHATSAPP', async () => undefined);
    service.registerReplayer('RAZORPAY', async () => undefined);

    expect(service.registeredSources()).toEqual(['RAZORPAY', 'STRIPE', 'WHATSAPP']);
  });
});
