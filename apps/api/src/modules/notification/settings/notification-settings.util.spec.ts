import { NotificationDigestFrequency } from '@prisma/client';
import {
  instantForLocalWallClock,
  isValidTimeZone,
  isWithinWindow,
  nextDigestAt,
  quietHoursEndAfter,
  resolveAlertDelivery,
  safeTimeZone,
  zonedDayOfWeek,
  zonedMinutesOfDay,
  zonedParts,
  type AlertRoutingSettings,
} from './notification-settings.util';
import { ALERT_SUPPRESSION_REASONS } from './notification-settings.constants';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

/** A settings row with every switch open, so each test narrows exactly one. */
function permissive(overrides: Partial<AlertRoutingSettings> = {}): AlertRoutingSettings {
  return {
    realtime_enabled: true,
    realtime_alerts: [],
    realtime_min_severity: 'INFO',
    muted_channels: [],
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_override_severity: null,
    timezone: IST,
    ...overrides,
  };
}

describe('timezone helpers', () => {
  describe('isValidTimeZone / safeTimeZone', () => {
    it('accepts real IANA zones and rejects invented ones', () => {
      expect(isValidTimeZone(IST)).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    });

    it('falls back to the product default rather than throwing on read', () => {
      // A row written by a runtime with a fuller tz database must not take the
      // digest sweep down for every other tenant in the same tick.
      expect(safeTimeZone('Mars/Olympus_Mons')).toBe(IST);
      expect(safeTimeZone(null)).toBe(IST);
      expect(safeTimeZone(NY)).toBe(NY);
    });
  });

  describe('zonedParts', () => {
    it('reads wall-clock fields in the target zone, not UTC', () => {
      // 2026-03-01T18:30:00Z is 2026-03-02 00:00 IST — a different date.
      const parts = zonedParts(new Date('2026-03-01T18:30:00Z'), IST);
      expect(parts).toMatchObject({ year: 2026, month: 3, day: 2, hour: 0, minute: 0 });
    });

    it('renders local midnight as hour 0, never 24', () => {
      // Some ICU builds emit "24" for midnight under hour12: false.
      expect(zonedParts(new Date('2026-03-01T18:30:00Z'), IST).hour).toBe(0);
    });
  });

  describe('zonedMinutesOfDay', () => {
    it('accounts for a half-hour zone offset', () => {
      // 09:15Z + 5:30 = 14:45 IST = 885 minutes.
      expect(zonedMinutesOfDay(new Date('2026-03-01T09:15:00Z'), IST)).toBe(885);
    });

    it('differs between zones for the same instant', () => {
      const instant = new Date('2026-03-01T09:15:00Z');
      expect(zonedMinutesOfDay(instant, IST)).not.toBe(zonedMinutesOfDay(instant, NY));
    });
  });

  describe('zonedDayOfWeek', () => {
    it('uses the local date, so a late-evening UTC instant can be the next day', () => {
      // 2026-03-01 is a Sunday; 20:00Z is already Monday 01:30 IST.
      expect(zonedDayOfWeek(new Date('2026-03-01T20:00:00Z'), 'UTC')).toBe(0);
      expect(zonedDayOfWeek(new Date('2026-03-01T20:00:00Z'), IST)).toBe(1);
    });
  });

  describe('instantForLocalWallClock', () => {
    it('round-trips a wall clock through the zone offset', () => {
      const instant = instantForLocalWallClock(
        { year: 2026, month: 6, day: 15, hour: 9, minute: 0 },
        IST,
      );
      expect(instant.toISOString()).toBe('2026-06-15T03:30:00.000Z');
    });

    it('uses the offset in force on the date, not the offset today', () => {
      // New York is UTC-5 in January and UTC-4 in July. A single-pass conversion
      // would put one of these an hour out.
      const winter = instantForLocalWallClock(
        { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
        NY,
      );
      const summer = instantForLocalWallClock(
        { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
        NY,
      );
      expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z');
      expect(summer.toISOString()).toBe('2026-07-15T13:00:00.000Z');
    });
  });
});

describe('isWithinWindow', () => {
  it('handles a same-day window as half-open [start, end)', () => {
    expect(isWithinWindow(540, 1020, 539)).toBe(false);
    expect(isWithinWindow(540, 1020, 540)).toBe(true);
    expect(isWithinWindow(540, 1020, 1019)).toBe(true);
    expect(isWithinWindow(540, 1020, 1020)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    // 22:00–07:00
    expect(isWithinWindow(1320, 420, 1380)).toBe(true); // 23:00
    expect(isWithinWindow(1320, 420, 60)).toBe(true); // 01:00
    expect(isWithinWindow(1320, 420, 600)).toBe(false); // 10:00
  });

  it('treats a zero-width window as never quiet', () => {
    // This is what lets an operator disable the window without clearing both
    // columns, so it must not read as "quiet all day".
    expect(isWithinWindow(600, 600, 600)).toBe(false);
    expect(isWithinWindow(600, 600, 0)).toBe(false);
  });
});

describe('quietHoursEndAfter', () => {
  it('returns null when either end is unset', () => {
    const now = new Date('2026-03-01T20:00:00Z');
    expect(quietHoursEndAfter(now, null, 420, IST)).toBeNull();
    expect(quietHoursEndAfter(now, 1320, null, IST)).toBeNull();
  });

  it('returns null when now is outside the window', () => {
    // 12:00 IST, window 22:00–07:00.
    expect(
      quietHoursEndAfter(new Date('2026-03-01T06:30:00Z'), 1320, 420, IST),
    ).toBeNull();
  });

  it('returns the end of a wrapping window that started yesterday', () => {
    // 01:00 IST on 2026-03-02, window 22:00–07:00 → ends 07:00 IST same day.
    const end = quietHoursEndAfter(new Date('2026-03-01T19:30:00Z'), 1320, 420, IST);
    expect(end?.toISOString()).toBe('2026-03-02T01:30:00.000Z');
  });

  it('returns the end of a wrapping window that started today', () => {
    // 23:00 IST on 2026-03-01 → ends 07:00 IST on 2026-03-02.
    const end = quietHoursEndAfter(new Date('2026-03-01T17:30:00Z'), 1320, 420, IST);
    expect(end?.toISOString()).toBe('2026-03-02T01:30:00.000Z');
  });

  it('resolves the window against the row’s zone, not IST', () => {
    // 03:00 New York = 13:30 IST. A 22:00–07:00 window is quiet in New York and
    // wide awake in IST; reading the wrong zone flips the answer.
    const at = new Date('2026-03-02T08:00:00Z');
    expect(quietHoursEndAfter(at, 1320, 420, NY)).not.toBeNull();
    expect(quietHoursEndAfter(at, 1320, 420, IST)).toBeNull();
  });
});

describe('resolveAlertDelivery', () => {
  const at = new Date('2026-03-01T06:30:00Z'); // 12:00 IST — outside any quiet window used here
  const alert = { kind: 'SLA_BREACH', severity: 'WARNING' };

  it('delivers immediately when nothing blocks it', () => {
    expect(resolveAlertDelivery(permissive(), alert, at)).toEqual({
      deliver: true,
      deferUntil: null,
      reason: null,
    });
  });

  it('withholds everything when the master switch is off', () => {
    const decision = resolveAlertDelivery(
      permissive({ realtime_enabled: false }),
      alert,
      at,
    );
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(ALERT_SUPPRESSION_REASONS.REALTIME_DISABLED);
  });

  it('treats an empty subscription list as every kind, not none', () => {
    // The column defaults to []. Reading empty as "nothing is on" would make
    // every business that never opened the settings page silently unreachable.
    expect(resolveAlertDelivery(permissive({ realtime_alerts: [] }), alert, at).deliver).toBe(
      true,
    );
  });

  it('withholds a kind outside a non-empty subscription list', () => {
    const decision = resolveAlertDelivery(
      permissive({ realtime_alerts: ['ESCALATION'] }),
      alert,
      at,
    );
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(ALERT_SUPPRESSION_REASONS.KIND_UNSUBSCRIBED);
  });

  it('ignores unknown kinds in the list rather than rejecting the row', () => {
    // A dashboard shipped ahead of the API writes a kind this build has never
    // heard of. The known entries must still work.
    const settings = permissive({ realtime_alerts: ['SLA_BREACH', 'TELEPATHY'] });
    expect(resolveAlertDelivery(settings, alert, at).deliver).toBe(true);
    expect(
      resolveAlertDelivery(settings, { kind: 'ESCALATION', severity: 'WARNING' }, at).deliver,
    ).toBe(false);
  });

  it('falls back to "all kinds" when every entry is unknown', () => {
    // Filtering leaves an empty list, which is the permissive case. The
    // alternative — an unsatisfiable allow-list — would silence the tenant.
    const settings = permissive({ realtime_alerts: ['TELEPATHY'] });
    expect(resolveAlertDelivery(settings, alert, at).deliver).toBe(true);
  });

  it('withholds an alert from a muted channel', () => {
    const decision = resolveAlertDelivery(
      permissive({ muted_channels: ['INSTAGRAM'] }),
      { ...alert, sourceChannel: 'INSTAGRAM' },
      at,
    );
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(ALERT_SUPPRESSION_REASONS.CHANNEL_MUTED);
  });

  it('never mutes an alert that has no source channel', () => {
    // Billing and platform-health alerts carry no conversation channel and must
    // not be caught by a channel mute.
    const decision = resolveAlertDelivery(
      permissive({ muted_channels: ['INSTAGRAM'] }),
      { ...alert, sourceChannel: null },
      at,
    );
    expect(decision.deliver).toBe(true);
  });

  it('withholds an alert below the minimum severity', () => {
    const decision = resolveAlertDelivery(
      permissive({ realtime_min_severity: 'CRITICAL' }),
      { kind: 'SLA_BREACH', severity: 'WARNING' },
      at,
    );
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(ALERT_SUPPRESSION_REASONS.BELOW_MIN_SEVERITY);
  });

  it('admits an alert exactly at the minimum severity', () => {
    const decision = resolveAlertDelivery(
      permissive({ realtime_min_severity: 'WARNING' }),
      { kind: 'SLA_BREACH', severity: 'WARNING' },
      at,
    );
    expect(decision.deliver).toBe(true);
  });

  it('ranks an unreadable minimum severity at the floor, not the ceiling', () => {
    // A threshold nobody can interpret must not silently become "page for
    // everything" — and must not silently drop everything either.
    const decision = resolveAlertDelivery(
      permissive({ realtime_min_severity: 'SHOUTY' }),
      { kind: 'SLA_BREACH', severity: 'INFO' },
      at,
    );
    expect(decision.deliver).toBe(true);
  });

  describe('quiet hours', () => {
    const quiet = { quiet_hours_start: 1320, quiet_hours_end: 420 }; // 22:00–07:00 IST
    const night = new Date('2026-03-01T19:30:00Z'); // 01:00 IST

    it('defers rather than drops', () => {
      const decision = resolveAlertDelivery(permissive(quiet), alert, night);
      expect(decision.deliver).toBe(true);
      expect(decision.reason).toBe(ALERT_SUPPRESSION_REASONS.QUIET_HOURS);
      expect(decision.deferUntil?.toISOString()).toBe('2026-03-02T01:30:00.000Z');
    });

    it('pages through quiet hours at or above the override severity', () => {
      const decision = resolveAlertDelivery(
        permissive({ ...quiet, quiet_hours_override_severity: 'CRITICAL' }),
        { kind: 'SLA_BREACH', severity: 'CRITICAL' },
        night,
      );
      expect(decision.deliver).toBe(true);
      expect(decision.deferUntil).toBeNull();
      expect(decision.reason).toBeNull();
    });

    it('still defers below the override severity', () => {
      const decision = resolveAlertDelivery(
        permissive({ ...quiet, quiet_hours_override_severity: 'CRITICAL' }),
        { kind: 'SLA_BREACH', severity: 'WARNING' },
        night,
      );
      expect(decision.deferUntil).not.toBeNull();
    });

    it('reports a muted channel as muted, not as deferred', () => {
      // Ordering matters: a muted alert must not come back at the end of the
      // window. The cheap switches run before the quiet-hours check.
      const decision = resolveAlertDelivery(
        permissive({ ...quiet, muted_channels: ['INSTAGRAM'] }),
        { ...alert, sourceChannel: 'INSTAGRAM' },
        night,
      );
      expect(decision.deliver).toBe(false);
      expect(decision.reason).toBe(ALERT_SUPPRESSION_REASONS.CHANNEL_MUTED);
      expect(decision.deferUntil).toBeNull();
    });
  });
});

describe('nextDigestAt', () => {
  const from = new Date('2026-03-01T06:30:00Z'); // 12:00 IST, a Sunday

  it('returns null when the digest is off', () => {
    expect(
      nextDigestAt(from, NotificationDigestFrequency.OFF, 9, 1, IST),
    ).toBeNull();
  });

  describe('HOURLY', () => {
    it('cuts on the local hour boundary in a half-hour-offset zone', () => {
      // The point of computing on the local clock: adding an hour to `from`
      // would cut at :30 past the local hour in IST.
      const next = nextDigestAt(from, NotificationDigestFrequency.HOURLY, 9, 1, IST);
      expect(next?.toISOString()).toBe('2026-03-01T07:30:00.000Z'); // 13:00 IST
    });

    it('always advances strictly past `from`', () => {
      // Exactly on the hour boundary — an inclusive result would re-cut forever.
      const onTheHour = new Date('2026-03-01T07:30:00.000Z'); // 13:00 IST exactly
      const next = nextDigestAt(onTheHour, NotificationDigestFrequency.HOURLY, 9, 1, IST);
      expect(next!.getTime()).toBeGreaterThan(onTheHour.getTime());
      expect(next?.toISOString()).toBe('2026-03-01T08:30:00.000Z'); // 14:00 IST
    });

    it('rolls into the next local day at midnight', () => {
      const lateNight = new Date('2026-03-01T18:00:00Z'); // 23:30 IST
      const next = nextDigestAt(lateNight, NotificationDigestFrequency.HOURLY, 9, 1, IST);
      expect(next?.toISOString()).toBe('2026-03-01T18:30:00.000Z'); // 00:00 IST next day
    });
  });

  describe('DAILY', () => {
    it('picks today when the hour is still ahead', () => {
      const early = new Date('2026-03-01T01:00:00Z'); // 06:30 IST
      const next = nextDigestAt(early, NotificationDigestFrequency.DAILY, 9, 1, IST);
      expect(next?.toISOString()).toBe('2026-03-01T03:30:00.000Z'); // 09:00 IST today
    });

    it('rolls to tomorrow when the hour has passed', () => {
      const next = nextDigestAt(from, NotificationDigestFrequency.DAILY, 9, 1, IST);
      expect(next?.toISOString()).toBe('2026-03-02T03:30:00.000Z'); // 09:00 IST tomorrow
    });

    it('holds 09:00 local across a DST transition', () => {
      // New York springs forward on 2026-03-08. A digest anchored to a fixed
      // UTC offset would drift to 08:00 or 10:00 local on the far side.
      const beforeDst = new Date('2026-03-07T15:00:00Z'); // 10:00 EST
      const next = nextDigestAt(beforeDst, NotificationDigestFrequency.DAILY, 9, 1, NY);
      expect(next?.toISOString()).toBe('2026-03-08T13:00:00.000Z'); // 09:00 EDT
      expect(zonedParts(next!, NY).hour).toBe(9);
    });
  });

  describe('WEEKLY', () => {
    it('advances to the next occurrence of the target weekday', () => {
      // `from` is Sunday 12:00 IST; target Monday 09:00 IST.
      const next = nextDigestAt(from, NotificationDigestFrequency.WEEKLY, 9, 1, IST);
      expect(next?.toISOString()).toBe('2026-03-02T03:30:00.000Z');
      expect(zonedDayOfWeek(next!, IST)).toBe(1);
    });

    it('skips a full week when today is the target day but the hour has passed', () => {
      // Sunday 12:00 IST, target Sunday 09:00 — this week's cut is behind us.
      const next = nextDigestAt(from, NotificationDigestFrequency.WEEKLY, 9, 0, IST);
      expect(next?.toISOString()).toBe('2026-03-08T03:30:00.000Z');
      expect(zonedDayOfWeek(next!, IST)).toBe(0);
    });

    it('uses today when the target hour is still ahead', () => {
      const early = new Date('2026-03-01T01:00:00Z'); // Sunday 06:30 IST
      const next = nextDigestAt(early, NotificationDigestFrequency.WEEKLY, 9, 0, IST);
      expect(next?.toISOString()).toBe('2026-03-01T03:30:00.000Z');
    });
  });

  it('clamps an out-of-range hour or weekday instead of throwing', () => {
    // These arrive from a stale client. A read path must not throw on them.
    expect(
      nextDigestAt(from, NotificationDigestFrequency.DAILY, 99, 1, IST),
    ).toBeInstanceOf(Date);
    expect(
      nextDigestAt(from, NotificationDigestFrequency.WEEKLY, 9, 99, IST),
    ).toBeInstanceOf(Date);
  });

  it('falls back to the default zone for an unresolvable timezone', () => {
    const next = nextDigestAt(from, NotificationDigestFrequency.DAILY, 9, 1, 'Mars/Base');
    expect(next?.toISOString()).toBe('2026-03-02T03:30:00.000Z');
  });
});
