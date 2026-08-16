import { Logger } from '@nestjs/common';
import {
  NotificationCategory,
  NotificationDigestFrequency,
  NotificationStatus,
  NotificationTemplateChannel,
} from '@prisma/client';
import { NotificationDigestListener, type DigestDueEvent } from './notification-digest.listener';
import { NotificationRepository } from '../notification.repository';
import { NotificationService } from '../notification.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function makeEvent(overrides: Partial<DigestDueEvent> = {}): DigestDueEvent {
  return {
    businessId: BUSINESS_ID,
    windowStart: new Date('2026-02-28T03:30:00Z'),
    windowEnd: new Date('2026-03-01T03:30:00Z'),
    recipients: ['ops@example.invalid'],
    frequency: NotificationDigestFrequency.DAILY,
    skipWhenEmpty: true,
    timestamp: new Date('2026-03-01T03:30:00Z'),
    ...overrides,
  };
}

describe('NotificationDigestListener', () => {
  let repository: { aggregateStats: jest.Mock };
  let service: { dispatch: jest.Mock };
  let listener: NotificationDigestListener;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repository = {
      aggregateStats: jest.fn().mockResolvedValue({
        byStatus: [
          { status: NotificationStatus.SENT, count: 4 },
          { status: NotificationStatus.DELIVERED, count: 3 },
          { status: NotificationStatus.FAILED, count: 1 },
        ],
        byChannel: [{ channel: NotificationTemplateChannel.EMAIL, count: 8 }],
      }),
    };
    service = { dispatch: jest.fn().mockResolvedValue(undefined) };

    listener = new NotificationDigestListener(
      repository as unknown as NotificationRepository,
      service as unknown as NotificationService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('summarises the window from this module’s own delivery rows', async () => {
    await listener.handleDigestDue(makeEvent());

    expect(repository.aggregateStats).toHaveBeenCalledWith(
      BUSINESS_ID,
      new Date('2026-02-28T03:30:00Z'),
      new Date('2026-03-01T03:30:00Z'),
    );

    const dispatched = service.dispatch.mock.calls[0]![1];
    expect(dispatched.data).toMatchObject({ total: 8, sent: 4, delivered: 3, failed: 1 });
  });

  it('dispatches as SYSTEM/EMAIL so client opt-outs cannot filter it', async () => {
    // A digest is an operational report to the business's own staff, not
    // marketing to a customer.
    await listener.handleDigestDue(makeEvent());

    expect(service.dispatch).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({
        channel: NotificationTemplateChannel.EMAIL,
        category: NotificationCategory.SYSTEM,
        recipient: 'ops@example.invalid',
      }),
    );
  });

  it('sends one notification per recipient', async () => {
    await listener.handleDigestDue(
      makeEvent({ recipients: ['a@example.invalid', 'b@example.invalid'] }),
    );
    expect(service.dispatch).toHaveBeenCalledTimes(2);
  });

  it('gives each recipient a distinct dedupe key', async () => {
    // A shared key would mean only the first recipient ever received a digest.
    await listener.handleDigestDue(
      makeEvent({ recipients: ['a@example.invalid', 'b@example.invalid'] }),
    );
    const keys = service.dispatch.mock.calls.map((c) => c[1].dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('keys the dedupe on the window end, so a redelivered event cannot double-send', async () => {
    await listener.handleDigestDue(makeEvent());
    expect(service.dispatch.mock.calls[0]![1].dedupeKey).toBe(
      'digest:DAILY:2026-03-01T03:30:00.000Z:ops@example.invalid',
    );
  });

  it('skips an empty window when the business asked it to', async () => {
    repository.aggregateStats.mockResolvedValue({ byStatus: [], byChannel: [] });
    await listener.handleDigestDue(makeEvent({ skipWhenEmpty: true }));
    expect(service.dispatch).not.toHaveBeenCalled();
  });

  it('sends an empty window when the business asked for it anyway', async () => {
    repository.aggregateStats.mockResolvedValue({ byStatus: [], byChannel: [] });
    await listener.handleDigestDue(makeEvent({ skipWhenEmpty: false }));
    expect(service.dispatch).toHaveBeenCalledTimes(1);
    expect(service.dispatch.mock.calls[0]![1].data).toMatchObject({ total: 0 });
  });

  it('labels the subject by frequency', async () => {
    await listener.handleDigestDue(
      makeEvent({ frequency: NotificationDigestFrequency.WEEKLY }),
    );
    expect(service.dispatch.mock.calls[0]![1].body.subject).toContain('Weekly');
  });

  it('singularises a one-notification subject', async () => {
    repository.aggregateStats.mockResolvedValue({
      byStatus: [{ status: NotificationStatus.SENT, count: 1 }],
      byChannel: [],
    });
    await listener.handleDigestDue(makeEvent());
    expect(service.dispatch.mock.calls[0]![1].body.subject).toContain('1 notification');
    expect(service.dispatch.mock.calls[0]![1].body.subject).not.toContain('notifications');
  });

  it('never rethrows into the emitter', async () => {
    // The claim is already committed by the time this runs; throwing here would
    // surface as an unhandled rejection on a cron tick and nothing more.
    repository.aggregateStats.mockRejectedValue(new Error('db down'));
    await expect(listener.handleDigestDue(makeEvent())).resolves.toBeUndefined();
  });

  it('does not abort the remaining recipients when one dispatch fails', async () => {
    // A bad address on the first operator must not withhold the digest from
    // everyone listed after them — and there is no retry, the claim has already
    // advanced. Asserting the second call happened, not merely that nothing
    // threw: a try/catch around the whole loop also swallows the error, and
    // silently drops recipient b.
    service.dispatch.mockRejectedValueOnce(new Error('smtp down'));

    await listener.handleDigestDue(
      makeEvent({ recipients: ['a@example.invalid', 'b@example.invalid'] }),
    );

    expect(service.dispatch).toHaveBeenCalledTimes(2);
    expect(service.dispatch.mock.calls[1]![1].recipient).toBe('b@example.invalid');
  });
});
