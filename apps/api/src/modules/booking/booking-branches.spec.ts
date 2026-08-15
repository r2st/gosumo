/**
 * Branch-coverage suite for BookingService.
 *
 * `booking.spec.ts` covers the happy paths of the lifecycle. This suite drives
 * the remaining conditional edges: slot-policy filters, Google Calendar
 * internals (token refresh, auth failure, create-vs-update), the realty
 * site-visit calendar bridge, reminder/auto-cancel guards, and the
 * payment.success auto-confirm handler.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingRepository } from './booking.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { GoogleCalendarService } from './google-calendar.service';
import { TenantService } from '../tenant/tenant.service';
import { BOOKING_QUEUE, STAFF_ROSTER_LIMIT } from './booking.constants';
import { BookingStatus, BookingActor, RecurrenceFrequency } from '@gosumo/shared';
import type { PaymentSuccessEvent } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const BOOKING_ID = '00000000-0000-4000-8000-000000000003';
const STAFF_ID = '00000000-0000-4000-8000-000000000004';
const PAYMENT_ID = '00000000-0000-4000-8000-000000000005';

const FUTURE_START = '2030-06-27T09:00:00.000Z';

function mockBooking(overrides: Record<string, unknown> = {}) {
  const start = new Date(FUTURE_START);
  return {
    id: BOOKING_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    catalog_item_id: null,
    status: BookingStatus.CONFIRMED,
    start_at: start,
    end_at: new Date(start.getTime() + 30 * 60_000),
    timezone: 'Asia/Kolkata',
    duration_minutes: 30,
    staff_id: null,
    recurrence_id: null,
    location_type: null,
    location_address: null,
    meeting_url: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    price: null,
    deposit_amount: null,
    payment_id: null,
    reminders_sent: 0,
    last_reminder_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    cancelled_by: null,
    notes: null,
    metadata: {},
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

/** Every weekday 09:00–10:00 IST, 30-minute slots, no policy limits. */
function mockAvailability(overrides: Record<string, unknown> = {}) {
  return {
    id: 'avail-1',
    business_id: BUSINESS_ID,
    staff_id: null,
    timezone: 'Asia/Kolkata',
    weekly_hours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 540,
      endMinute: 600,
    })),
    slot_interval_minutes: 30,
    buffer_minutes: 0,
    min_notice_minutes: 0,
    max_advance_days: 3650,
    capacity_per_slot: 1,
    is_active: true,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    business_id: BUSINESS_ID,
    staff_id: null,
    provider: 'google',
    google_calendar_id: 'primary',
    google_account_email: 'owner@biz.in',
    access_token: 'at-valid',
    refresh_token: 'rt-1',
    token_expires_at: new Date(Date.now() + 3600_000),
    scope: 'calendar.events',
    sync_enabled: true,
    last_synced_at: null,
    last_sync_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

/** ISO string N days from now, used to keep slot queries in the future. */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

describe('BookingService — branch coverage', () => {
  let service: BookingService;
  let repository: jest.Mocked<BookingRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let googleCalendar: jest.Mocked<GoogleCalendarService>;
  let queue: { add: jest.Mock; removeJobs: jest.Mock };
  let teamMembers: { findMany: jest.Mock };
  let tenantService: { assertTeamMember: jest.Mock };

  beforeEach(async () => {
    const mockRepository = {
      createBookingAtomic: jest.fn().mockResolvedValue(mockBooking() as never),
      countOverlapping: jest.fn().mockResolvedValue(0),
      findActiveBookingsInRange: jest.fn().mockResolvedValue([]),
      findBookingById: jest.fn().mockResolvedValue(mockBooking() as never),
      findBookings: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      }),
      findBookingsByRecurrence: jest.fn().mockResolvedValue([]),
      updateBooking: jest.fn().mockResolvedValue(mockBooking() as never),
      findByPaymentId: jest.fn(),
      findAvailability: jest.fn().mockResolvedValue(null),
      upsertAvailability: jest.fn(),
      listAvailability: jest.fn(),
      createBlock: jest.fn(),
      deleteBlock: jest.fn(),
      findBlocksInRange: jest.fn().mockResolvedValue([]),
      findConnection: jest.fn().mockResolvedValue(null),
      upsertConnection: jest.fn(),
      updateConnection: jest.fn().mockResolvedValue(undefined),
      deleteConnection: jest.fn().mockResolvedValue(undefined),
      createRecurrence: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      findRecurrence: jest.fn(),
      deactivateRecurrence: jest.fn().mockResolvedValue(undefined),
    };

    const mockGoogle = {
      getAuthUrl: jest.fn().mockReturnValue('https://consent'),
      exchangeCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      createEvent: jest.fn().mockResolvedValue({ eventId: 'evt-1' }),
      updateEvent: jest.fn().mockResolvedValue(undefined),
      deleteEvent: jest.fn().mockResolvedValue(undefined),
    };

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      removeJobs: jest.fn().mockResolvedValue(undefined),
    };
    teamMembers = { findMany: jest.fn().mockResolvedValue([]) };
    tenantService = { assertTeamMember: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: BookingRepository, useValue: mockRepository },
        { provide: PrismaService, useValue: { team_members: teamMembers } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: GoogleCalendarService, useValue: mockGoogle },
        { provide: getQueueToken(BOOKING_QUEUE), useValue: queue },
        { provide: TenantService, useValue: tenantService },
      ],
    }).compile();

    service = module.get(BookingService);
    repository = module.get(BookingRepository);
    eventEmitter = module.get(EventEmitter2);
    googleCalendar = module.get(GoogleCalendarService);
  });

  // ─── DTO mapping ─────────────────────────────

  describe('toBookingDto money mapping', () => {
    it('converts rupee price/deposit columns to paise', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ price: 1500, deposit_amount: 250.5 }) as never,
      );

      const dto = await service.getBooking(BUSINESS_ID, BOOKING_ID);

      expect(dto.pricePaise).toBe(150_000);
      expect(dto.depositPaise).toBe(25_050);
    });
  });

  // ─── createBooking / validation guards ───────

  // ─── staffId tenant guard ────────────────────

  /**
   * `staffId` arrives in the request body, so @TenantId() does not scope it.
   * `bookings.staff_id` is satisfied by any real member row, and the
   * availability/block/connection tables key on it with no tenant join — every
   * write path that accepts one must reject a member of another business, and
   * must do so before any row is written or any external call is made.
   */
  describe('staffId tenant guard', () => {
    const denied = new BadRequestException(
      `Team member ${STAFF_ID} does not belong to this business`,
    );

    beforeEach(() => {
      tenantService.assertTeamMember.mockRejectedValue(denied);
    });

    it('rejects a foreign staffId on createBooking', async () => {
      await expect(
        service.createBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: FUTURE_START,
          durationMinutes: 30,
          staffId: STAFF_ID,
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(tenantService.assertTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        STAFF_ID,
      );
      expect(repository.createBookingAtomic).not.toHaveBeenCalled();
    });

    it('rejects a foreign staffId on createRecurringBooking', async () => {
      await expect(
        service.createRecurringBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: FUTURE_START,
          durationMinutes: 30,
          staffId: STAFF_ID,
          frequency: RecurrenceFrequency.WEEKLY,
          count: 3,
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(repository.createRecurrence).not.toHaveBeenCalled();
    });

    it('rejects a foreign staffId on rescheduleBooking', async () => {
      await expect(
        service.rescheduleBooking(BUSINESS_ID, BOOKING_ID, {
          newStartAt: FUTURE_START,
          staffId: STAFF_ID,
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(repository.updateBooking).not.toHaveBeenCalled();
    });

    it('rejects a foreign staffId on setAvailability', async () => {
      await expect(
        service.setAvailability(BUSINESS_ID, {
          staffId: STAFF_ID,
          weeklyHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(repository.upsertAvailability).not.toHaveBeenCalled();
    });

    it('rejects a foreign staffId on blockSlot', async () => {
      await expect(
        service.blockSlot(BUSINESS_ID, {
          staffId: STAFF_ID,
          startAt: FUTURE_START,
          endAt: '2030-06-27T10:00:00.000Z',
          reason: 'Leave',
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(repository.createBlock).not.toHaveBeenCalled();
    });

    /** The OAuth code is single-use — a rejected staffId must not burn it. */
    it('rejects a foreign staffId before exchanging the OAuth code', async () => {
      await expect(
        service.connectGoogleCalendar(BUSINESS_ID, {
          authCode: 'code-1',
          redirectUri: 'https://app/cb',
          staffId: STAFF_ID,
        } as never),
      ).rejects.toThrow(BadRequestException);

      expect(googleCalendar.exchangeCode).not.toHaveBeenCalled();
      expect(repository.upsertConnection).not.toHaveBeenCalled();
    });
  });

  /** Business-wide rows carry no staff member, so the guard must stay out. */
  it('does not consult the tenant guard when staffId is omitted', async () => {
    await service.createBooking(BUSINESS_ID, {
      clientId: CLIENT_ID,
      startAt: FUTURE_START,
      durationMinutes: 30,
    } as never);

    expect(tenantService.assertTeamMember).not.toHaveBeenCalled();
    expect(repository.createBookingAtomic).toHaveBeenCalled();
  });

  describe('createBooking validation', () => {
    it('rejects an unparseable startAt', async () => {
      await expect(
        service.createBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: 'not-a-date',
          durationMinutes: 30,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a zero-length booking (end not after start)', async () => {
      await expect(
        service.createBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: FUTURE_START,
          durationMinutes: 0,
        }),
      ).rejects.toThrow('Booking end must be after start');
    });

    it('passes price and deposit through as rupees', async () => {
      repository.createBookingAtomic.mockResolvedValue(
        mockBooking({ price: 20, deposit_amount: 5 }) as never,
      );

      await service.createBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
        pricePaise: 2000,
        depositPaise: 500,
        autoConfirm: false,
      });

      const [data] = repository.createBookingAtomic.mock.calls[0]!;
      expect(data.price).toBe(20);
      expect(data.depositAmount).toBe(5);
    });
  });

  // ─── createRecurringBooking edges ────────────

  describe('createRecurringBooking', () => {
    const baseDto = {
      clientId: CLIENT_ID,
      startAt: FUTURE_START,
      durationMinutes: 30,
    };

    it('rejects a rule that expands to nothing', async () => {
      await expect(
        service.createRecurringBooking(BUSINESS_ID, {
          ...baseDto,
          recurrence: {
            frequency: RecurrenceFrequency.WEEKLY,
            // `until` before the anchor start → zero occurrences.
            until: '2029-01-01T00:00:00.000Z',
          },
        }),
      ).rejects.toThrow('Recurrence produced no occurrences');
    });

    it('rejects an invalid rule with the validator message', async () => {
      await expect(
        service.createRecurringBooking(BUSINESS_ID, {
          ...baseDto,
          recurrence: { frequency: RecurrenceFrequency.WEEKLY, interval: 0, count: 3 },
        }),
      ).rejects.toThrow('Recurrence interval must be a positive integer');
    });

    it('skips past occurrences and reports them', async () => {
      const result = await service.createRecurringBooking(BUSINESS_ID, {
        ...baseDto,
        startAt: new Date(Date.now() - 86_400_000).toISOString(),
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 2 },
      });

      expect(result.occurrences).toHaveLength(0);
      expect(result.skipped.every((s) => s.reason === 'in the past')).toBe(true);
      expect(repository.createBookingAtomic).not.toHaveBeenCalled();
    });

    it('skips occurrences that fall inside a blocked period', async () => {
      // A block spanning both daily occurrences. The interval must genuinely
      // overlap: the series-wide fetch applies the same predicate the
      // repository does, so a zero-length block at the occurrence start would
      // (correctly) not skip anything.
      repository.findBlocksInRange.mockResolvedValue([
        {
          id: 'blk-1',
          start_at: new Date('2030-06-27T00:00:00.000Z'),
          end_at: new Date('2030-06-29T00:00:00.000Z'),
        },
      ] as never);

      const result = await service.createRecurringBooking(BUSINESS_ID, {
        ...baseDto,
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 2 },
      });

      expect(result.occurrences).toHaveLength(0);
      expect(result.skipped.map((s) => s.reason)).toEqual(['blocked time', 'blocked time']);
    });

    it('fetches blocked slots once for the whole series, not once per occurrence', async () => {
      const result = await service.createRecurringBooking(BUSINESS_ID, {
        ...baseDto,
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 5 },
      });

      expect(result.occurrences).toHaveLength(5);
      expect(repository.findBlocksInRange).toHaveBeenCalledTimes(1);
      // The single window spans the first occurrence's start to the last one's end.
      const [, , windowStart, windowEnd] =
        repository.findBlocksInRange.mock.calls[0]!;
      expect((windowStart as Date).toISOString()).toBe(FUTURE_START);
      expect((windowEnd as Date).getTime()).toBeGreaterThan(
        new Date(FUTURE_START).getTime(),
      );
    });

    it('skips only the occurrences a mid-series block actually overlaps', async () => {
      // One block covering the second day alone — the other four days stand.
      repository.findBlocksInRange.mockResolvedValue([
        {
          id: 'blk-1',
          start_at: new Date('2030-06-28T00:00:00.000Z'),
          end_at: new Date('2030-06-29T00:00:00.000Z'),
        },
      ] as never);

      const result = await service.createRecurringBooking(BUSINESS_ID, {
        ...baseDto,
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 5 },
      });

      expect(result.occurrences).toHaveLength(4);
      expect(result.skipped).toEqual([
        { startAt: '2030-06-28T09:00:00.000Z', reason: 'blocked time' },
      ]);
    });

    it('records a non-Error rejection with the generic reason', async () => {
      repository.createBookingAtomic.mockRejectedValue('slot gone' as never);

      const result = await service.createRecurringBooking(BUSINESS_ID, {
        ...baseDto,
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 1 },
      });

      expect(result.skipped[0]!.reason).toBe('slot unavailable');
    });

    it('creates confirmed occurrences carrying price and deposit', async () => {
      repository.createBookingAtomic.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );

      const result = await service.createRecurringBooking(BUSINESS_ID, {
        ...baseDto,
        staffId: STAFF_ID,
        pricePaise: 5000,
        depositPaise: 1000,
        autoConfirm: true,
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 1 },
      });

      expect(result.occurrences).toHaveLength(1);
      const [data] = repository.createBookingAtomic.mock.calls[0]!;
      expect(data.price).toBe(50);
      expect(data.depositAmount).toBe(10);
      expect(data.status).toBe(BookingStatus.CONFIRMED);
    });
  });

  // ─── listBookings ────────────────────────────

  describe('listBookings', () => {
    it('parses the from/to window into Date instances', async () => {
      await service.listBookings(BUSINESS_ID, {
        from: '2030-06-01T00:00:00.000Z',
        to: '2030-06-30T00:00:00.000Z',
      });

      const [, filters] = repository.findBookings.mock.calls[0]!;
      expect(filters!.from).toEqual(new Date('2030-06-01T00:00:00.000Z'));
      expect(filters!.to).toEqual(new Date('2030-06-30T00:00:00.000Z'));
    });

    it('leaves the window undefined when neither bound is supplied', async () => {
      await service.listBookings(BUSINESS_ID, {});

      const [, filters] = repository.findBookings.mock.calls[0]!;
      expect(filters!.from).toBeUndefined();
      expect(filters!.to).toBeUndefined();
    });
  });

  // ─── lifecycle guards ────────────────────────

  describe('lifecycle guards', () => {
    it('refuses to cancel a completed booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.COMPLETED }) as never,
      );

      await expect(
        service.cancelBooking(BUSINESS_ID, BOOKING_ID, { reason: 'changed mind' }),
      ).rejects.toThrow('Cannot cancel a completed booking');
    });

    it('refuses to mark a cancelled booking as no-show', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );

      await expect(service.markNoShow(BUSINESS_ID, BOOKING_ID)).rejects.toThrow(
        'Cannot mark a CANCELLED booking as no-show',
      );
    });
  });

  // ─── setAvailability ─────────────────────────

  describe('setAvailability', () => {
    it('applies the documented defaults when tuning fields are omitted', async () => {
      repository.upsertAvailability.mockResolvedValue(mockAvailability() as never);

      await service.setAvailability(BUSINESS_ID, {
        weeklyHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
      });

      const [, staffId, data] = repository.upsertAvailability.mock.calls[0]!;
      expect(staffId).toBeNull();
      expect(data).toMatchObject({
        timezone: 'Asia/Kolkata',
        slotIntervalMinutes: 30,
        bufferMinutes: 0,
        minNoticeMinutes: 120,
        maxAdvanceDays: 60,
        capacityPerSlot: 1,
      });
    });
  });

  // ─── getAvailableSlots policy filters ────────

  describe('getAvailableSlots', () => {
    const query = { from: daysFromNow(1), to: daysFromNow(3), durationMinutes: 30 };

    it('rejects a range longer than the 62-day cap', async () => {
      await expect(
        service.getAvailableSlots(BUSINESS_ID, {
          from: daysFromNow(1),
          to: daysFromNow(90),
          durationMinutes: 30,
        }),
      ).rejects.toThrow('Slot query range cannot exceed 62 days');
    });

    it('returns nothing when the template has no weekly windows', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({ weekly_hours: [] }) as never,
      );

      await expect(service.getAvailableSlots(BUSINESS_ID, query)).resolves.toEqual([]);
    });

    it('returns nothing when weekly_hours is null', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({ weekly_hours: null }) as never,
      );

      await expect(service.getAvailableSlots(BUSINESS_ID, query)).resolves.toEqual([]);
    });

    it('drops every slot inside the minimum-notice window', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({ min_notice_minutes: 60 * 24 * 30 }) as never,
      );

      await expect(service.getAvailableSlots(BUSINESS_ID, query)).resolves.toEqual([]);
    });

    it('drops every slot beyond the maximum-advance horizon', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({ max_advance_days: 0 }) as never,
      );

      await expect(service.getAvailableSlots(BUSINESS_ID, query)).resolves.toEqual([]);
    });

    it('drops slots overlapping a blocked range', async () => {
      repository.findAvailability.mockResolvedValue(mockAvailability() as never);
      repository.findBlocksInRange.mockResolvedValue([
        {
          id: 'blk-1',
          start_at: new Date(Date.now() - 86_400_000),
          end_at: new Date(Date.now() + 10 * 86_400_000),
        },
      ] as never);

      await expect(service.getAvailableSlots(BUSINESS_ID, query)).resolves.toEqual([]);
    });

    it('forces capacity to 1 for a named staff member and tags the slots', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({ staff_id: STAFF_ID, capacity_per_slot: 5 }) as never,
      );

      const slots = await service.getAvailableSlots(BUSINESS_ID, {
        ...query,
        staffId: STAFF_ID,
      });

      expect(slots.length).toBeGreaterThan(0);
      expect(slots.every((s) => s.available === 1)).toBe(true);
      expect(slots.every((s) => s.staffId === STAFF_ID)).toBe(true);
    });

    it('de-duplicates a start time produced by two overlapping windows', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({
          weekly_hours: [0, 1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
            { dayOfWeek, startMinute: 540, endMinute: 600 },
            { dayOfWeek, startMinute: 540, endMinute: 630 },
          ]),
        }) as never,
      );

      const slots = await service.getAvailableSlots(BUSINESS_ID, query);
      const starts = slots.map((s) => s.startAt);

      expect(new Set(starts).size).toBe(starts.length);
      expect(starts).toEqual([...starts].sort());
    });
  });

  // ─── blockSlot ───────────────────────────────

  describe('blockSlot', () => {
    it('rejects an inverted block range', async () => {
      await expect(
        service.blockSlot(BUSINESS_ID, {
          startAt: '2030-06-27T10:00:00.000Z',
          endAt: '2030-06-27T09:00:00.000Z',
        }),
      ).rejects.toThrow('Block endAt must be after startAt');
    });
  });

  // ─── Google Calendar: connect / disconnect ───

  describe('Google Calendar connection', () => {
    it('builds a business-only OAuth state when no staff is given', () => {
      service.getGoogleAuthUrl(BUSINESS_ID);
      expect(googleCalendar.getAuthUrl).toHaveBeenCalledWith(BUSINESS_ID, undefined);
    });

    it('warns but still persists when Google returns no refresh token', async () => {
      googleCalendar.exchangeCode.mockResolvedValue({
        accessToken: 'at-1',
        refreshToken: null,
        expiresAt: new Date(Date.now() + 3600_000),
        scope: 'calendar.events',
      } as never);
      repository.upsertConnection.mockResolvedValue(
        mockConnection({ refresh_token: null }) as never,
      );

      const dto = await service.connectGoogleCalendar(BUSINESS_ID, { authCode: 'code-1' });

      expect(dto.connected).toBe(true);
      const [, staffId, data] = repository.upsertConnection.mock.calls[0]!;
      expect(staffId).toBeNull();
      expect(data.googleCalendarId).toBe('primary');
    });

    it('404s when disconnecting a business that never connected', async () => {
      await expect(service.disconnectGoogleCalendar(BUSINESS_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns null from getCalendarConnection when there is none', async () => {
      await expect(service.getCalendarConnection(BUSINESS_ID)).resolves.toBeNull();
    });

    it('maps a live connection to its DTO', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ last_synced_at: new Date('2026-06-01T00:00:00Z') }) as never,
      );

      const dto = await service.getCalendarConnection(BUSINESS_ID, STAFF_ID);

      expect(dto).toMatchObject({ connected: true, syncEnabled: true });
      expect(dto!.lastSyncedAt).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  // ─── Google Calendar: sync ───────────────────

  describe('syncGoogleCalendar', () => {
    it('rejects when sync is disabled on the connection', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ sync_enabled: false }) as never,
      );

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).rejects.toThrow(
        'No active Google Calendar connection',
      );
    });

    it('raises a HITL task and rejects when the token refresh fails', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: new Date(Date.now() - 1000) }) as never,
      );
      googleCalendar.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).rejects.toThrow(
        'Google Calendar token refresh failed — re-authentication required',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({ type: 'task.created' }),
      );
      expect(repository.updateConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        'conn-1',
        { last_sync_error: 'invalid_grant' },
      );
    });

    it('rejects when the connection has no refresh token to use', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: null, refresh_token: null }) as never,
      );

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(googleCalendar.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('skips cancelled/no-show bookings and other staff members', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ staff_id: STAFF_ID }) as never,
      );
      repository.findBookings.mockResolvedValue({
        data: [
          mockBooking({ id: 'b-cancelled', status: BookingStatus.CANCELLED }),
          mockBooking({ id: 'b-noshow', status: BookingStatus.NO_SHOW }),
          mockBooking({ id: 'b-other-staff', staff_id: 'someone-else' }),
          mockBooking({ id: 'b-mine', staff_id: STAFF_ID }),
        ],
        total: 4,
        page: 1,
        limit: 100,
        totalPages: 1,
      } as never);

      const result = await service.syncGoogleCalendar(BUSINESS_ID, STAFF_ID);

      expect(result).toEqual({ synced: 1, failed: 0 });
      expect(googleCalendar.createEvent).toHaveBeenCalledTimes(1);
    });

    it('counts a per-booking failure without aborting the run', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      repository.findBookings.mockResolvedValue({
        data: [mockBooking({ id: 'b-1' }), mockBooking({ id: 'b-2' })],
        total: 2,
        page: 1,
        limit: 100,
        totalPages: 1,
      } as never);
      googleCalendar.createEvent
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValueOnce({ eventId: 'evt-2' } as never);

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).resolves.toEqual({
        synced: 1,
        failed: 1,
      });
    });

    it('stringifies a non-Error per-booking failure', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      repository.findBookings.mockResolvedValue({
        data: [mockBooking({ id: 'b-1' })],
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      } as never);
      googleCalendar.createEvent.mockRejectedValue('boom' as never);

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).resolves.toEqual({
        synced: 0,
        failed: 1,
      });
    });

    it('refreshes an expiring token and reuses it across bookings', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: new Date(Date.now() + 1000) }) as never,
      );
      googleCalendar.refreshAccessToken.mockResolvedValue({
        accessToken: 'at-fresh',
        refreshToken: 'rt-2',
        expiresAt: new Date(Date.now() + 3600_000),
      } as never);
      repository.findBookings.mockResolvedValue({
        data: [mockBooking({ id: 'b-1' })],
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      } as never);

      await service.syncGoogleCalendar(BUSINESS_ID);

      expect(googleCalendar.refreshAccessToken).toHaveBeenCalledWith('rt-1');
      expect(googleCalendar.createEvent).toHaveBeenCalledWith(
        'at-fresh',
        'primary',
        expect.any(Object),
      );
    });
  });

  // ─── upsertCalendarEvent create vs update ────

  describe('pushBookingToCalendar', () => {
    it('updates in place when the booking already has an event id', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ google_calendar_id: null }) as never,
      );
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING, gcal_event_id: 'evt-existing' }) as never,
      );
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED, gcal_event_id: 'evt-existing' }) as never,
      );

      await service.confirmBooking(BUSINESS_ID, BOOKING_ID);

      expect(googleCalendar.updateEvent).toHaveBeenCalledWith(
        'at-valid',
        'primary',
        'evt-existing',
        expect.any(Object),
      );
      expect(googleCalendar.createEvent).not.toHaveBeenCalled();
    });

    it('is a no-op when the connection exists but sync is disabled', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ sync_enabled: false }) as never,
      );
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );

      await service.confirmBooking(BUSINESS_ID, BOOKING_ID);

      expect(googleCalendar.createEvent).not.toHaveBeenCalled();
    });

    it('swallows an auth failure and raises a HITL task instead', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: null, refresh_token: null }) as never,
      );
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );

      await expect(service.confirmBooking(BUSINESS_ID, BOOKING_ID)).resolves.toBeDefined();
      expect(eventEmitter.emit).toHaveBeenCalledWith('task.created', expect.any(Object));
      expect(googleCalendar.createEvent).not.toHaveBeenCalled();
    });

    it('swallows a non-Error thrown by the calendar client', async () => {
      repository.findConnection.mockRejectedValue('connection blew up' as never);
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );

      await expect(service.confirmBooking(BUSINESS_ID, BOOKING_ID)).resolves.toBeDefined();
    });

    it('records the created event id back onto the booking', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );

      await service.confirmBooking(BUSINESS_ID, BOOKING_ID);

      expect(repository.updateBooking).toHaveBeenCalledWith(BUSINESS_ID, BOOKING_ID, {
        gcal_event_id: 'evt-1',
        gcal_calendar_id: 'primary',
      });
    });
  });

  // ─── removeBookingFromCalendar ───────────────

  describe('removeBookingFromCalendar', () => {
    const synced = {
      status: BookingStatus.CONFIRMED,
      gcal_event_id: 'evt-1',
      gcal_calendar_id: 'primary',
    };

    it('deletes the Google event when the booking is cancelled', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking(synced) as never);
      repository.updateBooking.mockResolvedValue(mockBooking(synced) as never);
      repository.findConnection.mockResolvedValue(mockConnection() as never);

      await service.cancelBooking(BUSINESS_ID, BOOKING_ID, { reason: 'client asked' });

      expect(googleCalendar.deleteEvent).toHaveBeenCalledWith('at-valid', 'primary', 'evt-1');
    });

    it('does nothing when the calendar connection is gone', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking(synced) as never);
      repository.updateBooking.mockResolvedValue(mockBooking(synced) as never);
      repository.findConnection.mockResolvedValue(null as never);

      await service.cancelBooking(BUSINESS_ID, BOOKING_ID, { reason: 'client asked' });

      expect(googleCalendar.deleteEvent).not.toHaveBeenCalled();
    });

    it('never lets a delete failure break cancellation', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking(synced) as never);
      repository.updateBooking.mockResolvedValue(mockBooking(synced) as never);
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      googleCalendar.deleteEvent.mockRejectedValue('gone' as never);

      const result = await service.cancelBooking(BUSINESS_ID, BOOKING_ID, {
        reason: 'client asked',
        cancelledBy: BookingActor.CLIENT,
      });

      expect(result.id).toBe(BOOKING_ID);
    });
  });

  // ─── realty site-visit calendar bridge ───────

  describe('pushRealtyVisitToCalendar', () => {
    const params = {
      summary: 'Site visit — Prestige Lakeside',
      startAt: new Date(FUTURE_START),
      endAt: new Date(new Date(FUTURE_START).getTime() + 3600_000),
      timeZone: 'Asia/Kolkata',
    };

    it('returns null when there is no connection', async () => {
      await expect(
        service.pushRealtyVisitToCalendar(BUSINESS_ID, params),
      ).resolves.toBeNull();
    });

    it('returns null when sync is disabled', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ sync_enabled: false }) as never,
      );

      await expect(
        service.pushRealtyVisitToCalendar(BUSINESS_ID, params),
      ).resolves.toBeNull();
    });

    it('returns null and raises a HITL task when the token cannot be refreshed', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: null, refresh_token: null }) as never,
      );

      await expect(
        service.pushRealtyVisitToCalendar(BUSINESS_ID, params),
      ).resolves.toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith('task.created', expect.any(Object));
    });

    it('creates a new event with the default 2h reminder', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);

      const result = await service.pushRealtyVisitToCalendar(BUSINESS_ID, {
        ...params,
        staffId: STAFF_ID,
      });

      expect(result).toEqual({ eventId: 'evt-1', calendarId: 'primary' });
      expect(googleCalendar.createEvent).toHaveBeenCalledWith(
        'at-valid',
        'primary',
        expect.objectContaining({ reminderMinutes: [120] }),
      );
    });

    it('falls back to the primary calendar when the connection has none', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ google_calendar_id: null }) as never,
      );

      const result = await service.pushRealtyVisitToCalendar(BUSINESS_ID, params);

      expect(result!.calendarId).toBe('primary');
    });

    it('updates the existing event in place when ids are supplied', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);

      const result = await service.pushRealtyVisitToCalendar(BUSINESS_ID, {
        ...params,
        description: 'Bring the floor plan',
        location: 'Whitefield',
        reminderMinutes: [30],
        existingEventId: 'evt-old',
        existingCalendarId: 'cal-old',
      });

      expect(result).toEqual({ eventId: 'evt-old', calendarId: 'cal-old' });
      expect(googleCalendar.updateEvent).toHaveBeenCalledWith(
        'at-valid',
        'cal-old',
        'evt-old',
        expect.objectContaining({ reminderMinutes: [30], location: 'Whitefield' }),
      );
      expect(googleCalendar.createEvent).not.toHaveBeenCalled();
    });

    it('returns null (never throws) when the calendar call fails', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      googleCalendar.createEvent.mockRejectedValue(new Error('quota exceeded') as never);

      await expect(
        service.pushRealtyVisitToCalendar(BUSINESS_ID, params),
      ).resolves.toBeNull();
    });

    it('returns null when a non-Error escapes the calendar call', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      googleCalendar.createEvent.mockRejectedValue('kaput' as never);

      await expect(
        service.pushRealtyVisitToCalendar(BUSINESS_ID, params),
      ).resolves.toBeNull();
    });
  });

  describe('removeRealtyVisitFromCalendar', () => {
    const params = { calendarId: 'cal-1', eventId: 'evt-1' };

    it('deletes the event through the tenant connection', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);

      await service.removeRealtyVisitFromCalendar(BUSINESS_ID, {
        ...params,
        staffId: STAFF_ID,
      });

      expect(googleCalendar.deleteEvent).toHaveBeenCalledWith('at-valid', 'cal-1', 'evt-1');
    });

    it('is a no-op when there is no connection', async () => {
      await service.removeRealtyVisitFromCalendar(BUSINESS_ID, params);
      expect(googleCalendar.deleteEvent).not.toHaveBeenCalled();
    });

    it('swallows an Error from the delete call', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      googleCalendar.deleteEvent.mockRejectedValue(new Error('404 not found') as never);

      await expect(
        service.removeRealtyVisitFromCalendar(BUSINESS_ID, params),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error from the delete call', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      googleCalendar.deleteEvent.mockRejectedValue('nope' as never);

      await expect(
        service.removeRealtyVisitFromCalendar(BUSINESS_ID, params),
      ).resolves.toBeUndefined();
    });
  });

  // ─── calendar auth failure with a non-Error ──

  describe('handleCalendarAuthFailure', () => {
    it('stringifies a non-Error refresh rejection and survives a failed error write', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: new Date(Date.now() - 1000) }) as never,
      );
      googleCalendar.refreshAccessToken.mockRejectedValue('invalid_grant' as never);
      repository.updateConnection.mockRejectedValue(new Error('db down') as never);

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith('task.created', expect.any(Object));
    });
  });

  // ─── reminders ───────────────────────────────

  describe('reminders', () => {
    it('does nothing when the booking to remind about is gone', async () => {
      repository.findBookingById.mockResolvedValue(null as never);

      await service.scheduleReminders(BUSINESS_ID, BOOKING_ID);

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fires nothing when the reminded booking has been deleted', async () => {
      repository.findBookingById.mockResolvedValue(null as never);

      await service.fireReminder(BUSINESS_ID, BOOKING_ID, 60);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('fires nothing for a NO_SHOW booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.NO_SHOW }) as never,
      );

      await service.fireReminder(BUSINESS_ID, BOOKING_ID, 60);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('auto-cancel is a no-op when the booking no longer exists', async () => {
      repository.findBookingById.mockResolvedValue(null as never);

      await service.autoCancelIfUnpaid(BUSINESS_ID, BOOKING_ID);

      expect(repository.updateBooking).not.toHaveBeenCalled();
    });
  });

  // ─── staff roster ────────────────────────────

  describe('getStaffMembers', () => {
    it('derives a display name from the email when name is missing', async () => {
      teamMembers.findMany.mockResolvedValue([
        {
          id: 'm1',
          name: 'Alice',
          email: 'alice@biz.in',
          role: 'STAFF',
          avatar_url: 'https://img/a.png',
        },
        { id: 'm2', name: null, email: 'bob@biz.in', role: 'ADMIN', avatar_url: null },
        { id: 'm3', name: null, email: null, role: 'OWNER', avatar_url: null },
      ]);

      const { staff } = await service.getStaffMembers(BUSINESS_ID);

      expect(staff).toEqual([
        {
          id: 'm1',
          name: 'Alice',
          email: 'alice@biz.in',
          role: 'STAFF',
          avatarUrl: 'https://img/a.png',
        },
        { id: 'm2', name: 'bob', email: 'bob@biz.in', role: 'ADMIN', avatarUrl: null },
        { id: 'm3', name: 'Staff', email: null, role: 'OWNER', avatarUrl: null },
      ]);
      expect(teamMembers.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { business_id: BUSINESS_ID, deleted_at: null },
        }),
      );
    });

    /** A removed staff member must not stay assignable in the picker. */
    it('excludes soft-deleted members', async () => {
      teamMembers.findMany.mockResolvedValue([]);

      await service.getStaffMembers(BUSINESS_ID);

      const where = teamMembers.findMany.mock.calls.at(-1)![0].where as {
        deleted_at: null;
      };
      expect(where.deleted_at).toBeNull();
    });

    /** The picker is a dropdown; the read must not scale with the tenant. */
    it('bounds and orders the roster', async () => {
      teamMembers.findMany.mockResolvedValue([]);

      await service.getStaffMembers(BUSINESS_ID);

      const args = teamMembers.findMany.mock.calls.at(-1)![0] as {
        take: number;
        orderBy: Array<Record<string, string>>;
      };
      expect(args.take).toBe(STAFF_ROSTER_LIMIT);
      expect(args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    });

    it('degrades to an empty roster when the query fails', async () => {
      teamMembers.findMany.mockRejectedValue(new Error('relation does not exist'));

      await expect(service.getStaffMembers(BUSINESS_ID)).resolves.toEqual({ staff: [] });
    });

    it('degrades to an empty roster when the query returns nothing', async () => {
      teamMembers.findMany.mockResolvedValue(null);

      await expect(service.getStaffMembers(BUSINESS_ID)).resolves.toEqual({ staff: [] });
    });
  });

  // ─── payment.success handler ─────────────────

  describe('handlePaymentSuccess', () => {
    const event = (extra: Record<string, unknown> = {}) =>
      ({
        type: 'payment.success',
        id: 'evt-1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-1',
        paymentId: PAYMENT_ID,
        ...extra,
      }) as unknown as PaymentSuccessEvent;

    it('ignores a payment that is not attached to a booking', async () => {
      await service.handlePaymentSuccess(event());
      expect(repository.findBookingById).not.toHaveBeenCalled();
    });

    it('ignores a booking that is no longer PENDING', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );

      await service.handlePaymentSuccess(event({ bookingId: BOOKING_ID }));

      expect(repository.updateBooking).not.toHaveBeenCalled();
    });

    it('ignores a booking that has been deleted', async () => {
      repository.findBookingById.mockResolvedValue(null as never);

      await service.handlePaymentSuccess(event({ bookingId: BOOKING_ID }));

      expect(repository.updateBooking).not.toHaveBeenCalled();
    });

    it('stores a null payment id when the event carries none', async () => {
      repository.findBookingById
        .mockResolvedValueOnce(mockBooking({ status: BookingStatus.PENDING }) as never)
        .mockResolvedValue(mockBooking({ status: BookingStatus.PENDING }) as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );

      await service.handlePaymentSuccess(
        event({ bookingId: BOOKING_ID, paymentId: undefined }),
      );

      expect(repository.updateBooking).toHaveBeenCalledWith(BUSINESS_ID, BOOKING_ID, {
        payment_id: null,
      });
    });

    it('swallows a confirmation failure so the payment webhook still succeeds', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );
      repository.updateBooking.mockRejectedValue(new Error('deadlock detected') as never);

      await expect(
        service.handlePaymentSuccess(event({ bookingId: BOOKING_ID })),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error confirmation failure', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );
      repository.updateBooking.mockRejectedValue('deadlock' as never);

      await expect(
        service.handlePaymentSuccess(event({ bookingId: BOOKING_ID })),
      ).resolves.toBeUndefined();
    });
  });
});
