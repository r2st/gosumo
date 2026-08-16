import { BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotificationDigestFrequency,
  business_notification_settings,
} from '@prisma/client';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationSettingsRepository } from './notification-settings.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const IST = 'Asia/Kolkata';

type RepoMock = {
  [K in keyof NotificationSettingsRepository]: jest.Mock;
};

function makeRow(
  overrides: Partial<business_notification_settings> = {},
): business_notification_settings {
  return {
    id: '00000000-0000-4000-b000-000000000001',
    business_id: BUSINESS_ID,
    realtime_enabled: true,
    realtime_alerts: [],
    realtime_min_severity: 'WARNING',
    muted_channels: [],
    digest_frequency: NotificationDigestFrequency.DAILY,
    digest_hour: 9,
    digest_day_of_week: 1,
    digest_recipients: [],
    digest_skip_when_empty: true,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_override_severity: null,
    timezone: IST,
    fallback_email: null,
    last_digest_sent_at: null,
    next_digest_at: new Date('2026-03-01T03:30:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as business_notification_settings;
}

describe('NotificationSettingsService', () => {
  let repository: RepoMock;
  let emitter: { emit: jest.Mock };
  let service: NotificationSettingsService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    repository = {
      findByBusiness: jest.fn().mockResolvedValue(makeRow()),
      ensureForBusiness: jest.fn().mockResolvedValue(makeRow()),
      updateForBusiness: jest.fn().mockResolvedValue(1),
      findDueDigestsGlobal: jest.fn().mockResolvedValue([]),
      claimDigest: jest.fn().mockResolvedValue(true),
      findBusinessEmail: jest.fn().mockResolvedValue(null),
      findDigestDueAt: jest.fn().mockResolvedValue(null),
    } as unknown as RepoMock;

    emitter = { emit: jest.fn() };
    service = new NotificationSettingsService(
      repository as unknown as NotificationSettingsRepository,
      emitter as unknown as EventEmitter2,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('getSettings', () => {
    it('returns the existing row without writing', async () => {
      const dto = await service.getSettings(BUSINESS_ID);
      expect(dto.businessId).toBe(BUSINESS_ID);
      expect(repository.ensureForBusiness).not.toHaveBeenCalled();
    });

    it('creates a defaults row on first read', async () => {
      // The row has to exist for the schedule to exist — the sweep selects on
      // `next_digest_at`, so a business with no row is a business with no digest.
      repository.findByBusiness.mockResolvedValue(null);
      await service.getSettings(BUSINESS_ID);

      expect(repository.ensureForBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ next_digest_at: expect.any(Date) }),
      );
    });

    it('serialises timestamps as ISO strings and nulls as null', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeRow({ last_digest_sent_at: null, next_digest_at: new Date('2026-03-01T03:30:00Z') }),
      );
      const dto = await service.getSettings(BUSINESS_ID);
      expect(dto.lastDigestSentAt).toBeNull();
      expect(dto.nextDigestAt).toBe('2026-03-01T03:30:00.000Z');
    });
  });

  describe('updateSettings', () => {
    it('maps camelCase fields onto snake_case columns', async () => {
      await service.updateSettings(BUSINESS_ID, {
        realtimeEnabled: false,
        mutedChannels: ['INSTAGRAM'],
        realtimeMinSeverity: 'CRITICAL',
      });

      expect(repository.updateForBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          realtime_enabled: false,
          muted_channels: ['INSTAGRAM'],
          realtime_min_severity: 'CRITICAL',
        }),
      );
    });

    it('omits fields the caller did not send', async () => {
      // The endpoint is a partial update: a dashboard card that only owns quiet
      // hours must not blank the digest fields it never rendered.
      await service.updateSettings(BUSINESS_ID, { realtimeEnabled: false });
      const patch = repository.updateForBusiness.mock.calls[0]![1];
      expect(Object.keys(patch)).toEqual(['realtime_enabled']);
    });

    it('rejects an unresolvable timezone', async () => {
      await expect(
        service.updateSettings(BUSINESS_ID, { timezone: 'Mars/Base' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.updateForBusiness).not.toHaveBeenCalled();
    });

    it('rejects setting only one end of the quiet window', async () => {
      await expect(
        service.updateSettings(BUSINESS_ID, { quietHoursStart: 1320 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects clearing only one end of an existing window', async () => {
      // Validated against the merged row, not the patch: clearing one end of a
      // configured window is just as broken as setting one of two.
      repository.findByBusiness.mockResolvedValue(
        makeRow({ quiet_hours_start: 1320, quiet_hours_end: 420 }),
      );
      await expect(
        service.updateSettings(BUSINESS_ID, { quietHoursEnd: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts both ends together', async () => {
      await expect(
        service.updateSettings(BUSINESS_ID, { quietHoursStart: 1320, quietHoursEnd: 420 }),
      ).resolves.toBeDefined();
    });

    it('accepts clearing both ends together', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeRow({ quiet_hours_start: 1320, quiet_hours_end: 420 }),
      );
      await expect(
        service.updateSettings(BUSINESS_ID, { quietHoursStart: null, quietHoursEnd: null }),
      ).resolves.toBeDefined();
    });

    it.each([
      ['digestFrequency', { digestFrequency: NotificationDigestFrequency.WEEKLY }],
      ['digestHour', { digestHour: 18 }],
      ['digestDayOfWeek', { digestDayOfWeek: 3 }],
      ['timezone', { timezone: 'America/New_York' }],
    ])('recomputes next_digest_at when %s changes', async (_label, patch) => {
      // `next_digest_at` is a stored column the sweep selects on, so every write
      // that could move the next cut has to move it.
      await service.updateSettings(BUSINESS_ID, patch);
      const written = repository.updateForBusiness.mock.calls[0]![1];
      expect(written).toHaveProperty('next_digest_at');
      expect(written.next_digest_at).toBeInstanceOf(Date);
    });

    it('leaves next_digest_at alone when no scheduling field changes', async () => {
      await service.updateSettings(BUSINESS_ID, { realtimeEnabled: false });
      expect(repository.updateForBusiness.mock.calls[0]![1]).not.toHaveProperty(
        'next_digest_at',
      );
    });

    it('clears next_digest_at when the digest is switched off', async () => {
      await service.updateSettings(BUSINESS_ID, {
        digestFrequency: NotificationDigestFrequency.OFF,
      });
      expect(repository.updateForBusiness.mock.calls[0]![1].next_digest_at).toBeNull();
    });

    it('recomputes against the merged row, not the patch alone', async () => {
      // Changing only the hour must still schedule using the row's stored
      // frequency and zone.
      repository.findByBusiness.mockResolvedValue(
        makeRow({ digest_frequency: NotificationDigestFrequency.WEEKLY, digest_day_of_week: 3 }),
      );
      await service.updateSettings(BUSINESS_ID, { digestHour: 18 });
      const next = repository.updateForBusiness.mock.calls[0]![1].next_digest_at as Date;
      // Wednesday (3) at 18:00 IST = 12:30 UTC.
      expect(next.toISOString().endsWith('12:30:00.000Z')).toBe(true);
    });
  });

  describe('resolveAlert', () => {
    it('applies the stored rules', async () => {
      repository.findByBusiness.mockResolvedValue(makeRow({ realtime_enabled: false }));
      const decision = await service.resolveAlert(BUSINESS_ID, {
        kind: 'SLA_BREACH',
        severity: 'CRITICAL',
      });
      expect(decision.deliver).toBe(false);
    });

    it('delivers when the settings row cannot be read', async () => {
      // A caller raising an SLA breach must not lose the alert because the
      // settings lookup failed. Failing open is the safe direction here.
      repository.findByBusiness.mockRejectedValue(new Error('db down'));
      const decision = await service.resolveAlert(BUSINESS_ID, {
        kind: 'SLA_BREACH',
        severity: 'CRITICAL',
      });
      expect(decision).toEqual({ deliver: true, deferUntil: null, reason: null });
    });
  });

  describe('previewAlert', () => {
    it('evaluates at the supplied instant', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeRow({ quiet_hours_start: 1320, quiet_hours_end: 420 }),
      );
      const preview = await service.previewAlert(BUSINESS_ID, {
        kind: 'SLA_BREACH',
        severity: 'WARNING',
        at: '2026-03-01T19:30:00Z', // 01:00 IST — inside the window
      });
      expect(preview.deferUntil).toBe('2026-03-02T01:30:00.000Z');
    });

    it('rejects an unparseable instant', async () => {
      await expect(
        service.previewAlert(BUSINESS_ID, {
          kind: 'SLA_BREACH',
          severity: 'WARNING',
          at: 'yesterday',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('resolveDigestRecipients', () => {
    it('prefers the explicit recipient list', async () => {
      const row = makeRow({
        digest_recipients: ['ops@example.invalid'],
        fallback_email: 'fallback@example.invalid',
      });
      await expect(service.resolveDigestRecipients(BUSINESS_ID, row)).resolves.toEqual([
        'ops@example.invalid',
      ]);
      expect(repository.findBusinessEmail).not.toHaveBeenCalled();
    });

    it('falls back to the escalation address', async () => {
      const row = makeRow({ fallback_email: 'fallback@example.invalid' });
      await expect(service.resolveDigestRecipients(BUSINESS_ID, row)).resolves.toEqual([
        'fallback@example.invalid',
      ]);
    });

    it('falls back to the business’s own address last', async () => {
      repository.findBusinessEmail.mockResolvedValue('owner@example.invalid');
      await expect(service.resolveDigestRecipients(BUSINESS_ID, makeRow())).resolves.toEqual([
        'owner@example.invalid',
      ]);
    });

    it('returns nothing rather than inventing a recipient', async () => {
      repository.findBusinessEmail.mockResolvedValue(null);
      await expect(service.resolveDigestRecipients(BUSINESS_ID, makeRow())).resolves.toEqual(
        [],
      );
    });
  });

  describe('sweepDueDigests', () => {
    const now = new Date('2026-03-01T04:00:00Z'); // past the row's next_digest_at

    beforeEach(() => {
      repository.findDueDigestsGlobal.mockResolvedValue([
        { id: 'row-1', business_id: BUSINESS_ID },
      ]);
      repository.findBusinessEmail.mockResolvedValue('owner@example.invalid');
    });

    it('claims the row before emitting anything', async () => {
      const order: string[] = [];
      repository.claimDigest.mockImplementation(() => {
        order.push('claim');
        return Promise.resolve(true);
      });
      emitter.emit.mockImplementation(() => {
        order.push('emit');
        return true;
      });

      await service.sweepDueDigests(now);
      // Building first and claiming after would send the same digest twice when
      // two ticks overlap.
      expect(order).toEqual(['claim', 'emit']);
    });

    it('advances the schedule as part of the claim', async () => {
      await service.sweepDueDigests(now);
      const [, dueAt, nextAt] = repository.claimDigest.mock.calls[0]!;
      expect(dueAt).toEqual(new Date('2026-03-01T03:30:00Z'));
      expect(nextAt).toBeInstanceOf(Date);
      expect((nextAt as Date).getTime()).toBeGreaterThan(now.getTime());
    });

    it('predicates the claim on the due time it read', async () => {
      // This is what makes two overlapping ticks cut one digest rather than two.
      await service.sweepDueDigests(now);
      expect(repository.claimDigest).toHaveBeenCalledWith(
        BUSINESS_ID,
        new Date('2026-03-01T03:30:00Z'),
        expect.any(Date),
        now,
      );
    });

    it('skips without emitting when the claim is lost', async () => {
      repository.claimDigest.mockResolvedValue(false);
      const result = await service.sweepDueDigests(now);

      expect(emitter.emit).not.toHaveBeenCalled();
      expect(result).toEqual({ found: 1, sent: 0, skipped: 1 });
    });

    it('re-reads through the scoped path rather than trusting the projection', async () => {
      // Also what re-checks that the row has not been switched off since the scan.
      repository.findByBusiness.mockResolvedValue(
        makeRow({ digest_frequency: NotificationDigestFrequency.OFF }),
      );
      const result = await service.sweepDueDigests(now);

      expect(repository.findByBusiness).toHaveBeenCalledWith(BUSINESS_ID);
      expect(repository.claimDigest).not.toHaveBeenCalled();
      expect(result.sent).toBe(0);
    });

    it('skips a row whose due time has moved into the future since the scan', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeRow({ next_digest_at: new Date('2026-03-05T03:30:00Z') }),
      );
      await service.sweepDueDigests(now);
      expect(repository.claimDigest).not.toHaveBeenCalled();
    });

    it('emits the window spanning the previous cut', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeRow({ last_digest_sent_at: new Date('2026-02-28T03:30:00Z') }),
      );
      await service.sweepDueDigests(now);

      expect(emitter.emit).toHaveBeenCalledWith(
        'notification.digest.due',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          windowStart: new Date('2026-02-28T03:30:00Z'),
          windowEnd: now,
          recipients: ['owner@example.invalid'],
        }),
      );
    });

    it('uses the due time as the window start on the first ever cut', async () => {
      await service.sweepDueDigests(now);
      expect(emitter.emit.mock.calls[0]![1].windowStart).toEqual(
        new Date('2026-03-01T03:30:00Z'),
      );
    });

    it('still advances the schedule when there is no recipient', async () => {
      // Otherwise the sweep re-finds the same row every tick, forever.
      repository.findBusinessEmail.mockResolvedValue(null);
      const result = await service.sweepDueDigests(now);

      expect(repository.claimDigest).toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(result).toEqual({ found: 1, sent: 0, skipped: 1 });
    });

    it('isolates a failing business from the rest of the tick', async () => {
      repository.findDueDigestsGlobal.mockResolvedValue([
        { id: 'row-1', business_id: BUSINESS_ID },
        { id: 'row-2', business_id: '00000000-0000-4000-a000-000000000002' },
      ]);
      repository.findByBusiness
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValue(makeRow());

      const result = await service.sweepDueDigests(now);
      expect(result).toEqual({ found: 2, sent: 1, skipped: 1 });
    });

    it('reports an empty tick without touching anything', async () => {
      repository.findDueDigestsGlobal.mockResolvedValue([]);
      const result = await service.sweepDueDigests(now);

      expect(result).toEqual({ found: 0, sent: 0, skipped: 0 });
      expect(repository.claimDigest).not.toHaveBeenCalled();
    });
  });
});
