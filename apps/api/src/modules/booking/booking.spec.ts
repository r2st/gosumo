import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingRepository } from './booking.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { GoogleCalendarService } from './google-calendar.service';
import { TenantService } from '../tenant/tenant.service';
import { BOOKING_QUEUE, BOOKING_JOBS } from './booking.constants';
import { BookingStatus, BookingActor, RecurrenceFrequency, ValidationError } from '@gosumo/shared';
import type { PaymentSuccessEvent } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Test constants & fixtures
// ─────────────────────────────────────────────

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const BOOKING_ID = '00000000-0000-4000-8000-000000000003';
const STAFF_ID = '00000000-0000-4000-8000-000000000004';
const PAYMENT_ID = '00000000-0000-4000-8000-000000000005';
const RECURRENCE_ID = '00000000-0000-4000-8000-000000000006';

/** A start time comfortably in the future so "not in the past" passes. */
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

function mockAvailability(overrides: Record<string, unknown> = {}) {
  return {
    id: 'avail-1',
    business_id: BUSINESS_ID,
    staff_id: null,
    timezone: 'Asia/Kolkata',
    // Every weekday, 09:00–10:00 IST.
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

// ─────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────

describe('BookingService', () => {
  let service: BookingService;
  let repository: jest.Mocked<BookingRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let googleCalendar: jest.Mocked<GoogleCalendarService>;
  let queue: { add: jest.Mock; removeJobs: jest.Mock };
  let tenantService: { assertTeamMember: jest.Mock };

  beforeEach(async () => {
    const mockRepository = {
      createBookingAtomic: jest.fn(),
      countOverlapping: jest.fn().mockResolvedValue(0),
      findActiveBookingsInRange: jest.fn().mockResolvedValue([]),
      findBookingById: jest.fn(),
      findBookings: jest.fn(),
      findBookingsByRecurrence: jest.fn().mockResolvedValue([]),
      updateBooking: jest.fn(),
      transitionStatus: jest.fn(),
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
      createRecurrence: jest.fn(),
      findRecurrence: jest.fn(),
      deactivateRecurrence: jest.fn(),
    };

    const mockGoogle = {
      getAuthUrl: jest.fn().mockReturnValue('https://consent'),
      exchangeCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      createEvent: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
    };

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      removeJobs: jest.fn().mockResolvedValue(undefined),
    };
    tenantService = { assertTeamMember: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: BookingRepository, useValue: mockRepository },
        { provide: PrismaService, useValue: {} },
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

  // ─── createBooking ───

  describe('createBooking', () => {
    it('creates a PENDING booking and schedules an auto-cancel job', async () => {
      repository.createBookingAtomic.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );

      const result = await service.createBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
      });

      expect(result.status).toBe(BookingStatus.PENDING);
      const [data, capacity] = repository.createBookingAtomic.mock.calls[0]!;
      expect(data.businessId).toBe(BUSINESS_ID);
      expect(data.status).toBe(BookingStatus.PENDING);
      expect(capacity).toBe(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.created',
        expect.objectContaining({ type: 'booking.created' }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        BOOKING_JOBS.AUTO_CANCEL,
        expect.objectContaining({ bookingId: BOOKING_ID }),
        expect.objectContaining({ jobId: `autocancel:${BOOKING_ID}` }),
      );
    });

    it('creates a CONFIRMED booking with reminders when autoConfirm is set', async () => {
      const confirmed = mockBooking({ status: BookingStatus.CONFIRMED });
      repository.createBookingAtomic.mockResolvedValue(confirmed as never);
      repository.findBookingById.mockResolvedValue(confirmed as never);

      const result = await service.createBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
        autoConfirm: true,
      });

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      // 24h + 1h reminders both scheduled (start is far in the future).
      const reminderCalls = queue.add.mock.calls.filter(
        (c) => c[0] === BOOKING_JOBS.REMINDER,
      );
      expect(reminderCalls).toHaveLength(2);
    });

    it('converts price paise to rupees for storage', async () => {
      repository.createBookingAtomic.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING, price: 500 }) as never,
      );
      await service.createBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
        pricePaise: 50000,
      });
      const [data] = repository.createBookingAtomic.mock.calls[0]!;
      expect(data.price).toBe(500); // 50000 paise → ₹500
    });

    it('rejects a booking in the past', async () => {
      await expect(
        service.createBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: '2020-01-01T09:00:00Z',
          durationMinutes: 30,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.createBookingAtomic).not.toHaveBeenCalled();
    });

    it('rejects a booking that falls inside a blocked period', async () => {
      repository.findBlocksInRange.mockResolvedValue([
        { id: 'blk', start_at: new Date(FUTURE_START), end_at: new Date() } as never,
      ]);
      await expect(
        service.createBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: FUTURE_START,
          durationMinutes: 30,
        }),
      ).rejects.toThrow(/blocked/);
    });

    it('uses capacity 1 for a named staff member', async () => {
      repository.createBookingAtomic.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING, staff_id: STAFF_ID }) as never,
      );
      await service.createBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
        staffId: STAFF_ID,
      });
      const [, capacity] = repository.createBookingAtomic.mock.calls[0]!;
      expect(capacity).toBe(1);
      expect(repository.findAvailability).not.toHaveBeenCalled();
    });

    it('propagates the ConflictException from the atomic insert (double-booking)', async () => {
      repository.createBookingAtomic.mockRejectedValue(
        new ConflictException('Slot is fully booked'),
      );
      await expect(
        service.createBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: FUTURE_START,
          durationMinutes: 30,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── recurring ───

  describe('createRecurringBooking', () => {
    it('creates one booking per occurrence and reports skips', async () => {
      repository.createRecurrence.mockResolvedValue({ id: RECURRENCE_ID } as never);
      repository.createBookingAtomic.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING, recurrence_id: RECURRENCE_ID }) as never,
      );

      const result = await service.createRecurringBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
        recurrence: { frequency: RecurrenceFrequency.WEEKLY, count: 3 },
      });

      expect(result.recurrenceId).toBe(RECURRENCE_ID);
      expect(result.occurrences).toHaveLength(3);
      expect(repository.createBookingAtomic).toHaveBeenCalledTimes(3);
      // Every occurrence carries the recurrence id.
      const firstData = repository.createBookingAtomic.mock.calls[0]![0];
      expect(firstData.recurrenceId).toBe(RECURRENCE_ID);
    });

    it('skips occurrences whose slot is already taken without aborting the series', async () => {
      repository.createRecurrence.mockResolvedValue({ id: RECURRENCE_ID } as never);
      repository.createBookingAtomic
        .mockResolvedValueOnce(mockBooking({ status: BookingStatus.PENDING }) as never)
        .mockRejectedValueOnce(new ConflictException('taken'))
        .mockResolvedValueOnce(mockBooking({ status: BookingStatus.PENDING }) as never);

      const result = await service.createRecurringBooking(BUSINESS_ID, {
        clientId: CLIENT_ID,
        startAt: FUTURE_START,
        durationMinutes: 30,
        recurrence: { frequency: RecurrenceFrequency.DAILY, count: 3 },
      });

      expect(result.occurrences).toHaveLength(2);
      expect(result.skipped).toHaveLength(1);
    });

    it('rejects an unbounded recurrence rule', async () => {
      await expect(
        service.createRecurringBooking(BUSINESS_ID, {
          clientId: CLIENT_ID,
          startAt: FUTURE_START,
          durationMinutes: 30,
          recurrence: { frequency: RecurrenceFrequency.DAILY },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  // ─── confirm ───

  describe('confirmBooking', () => {
    it('transitions PENDING → CONFIRMED and schedules reminders', async () => {
      const pending = mockBooking({ status: BookingStatus.PENDING });
      repository.findBookingById
        .mockResolvedValueOnce(pending as never) // requireBooking
        .mockResolvedValue(mockBooking({ status: BookingStatus.CONFIRMED }) as never); // scheduleReminders
      repository.transitionStatus.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );

      const result = await service.confirmBooking(BUSINESS_ID, BOOKING_ID);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(repository.transitionStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        BOOKING_ID,
        BookingStatus.PENDING,
        expect.objectContaining({ status: BookingStatus.CONFIRMED }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.confirmed',
        expect.objectContaining({ type: 'booking.confirmed' }),
      );
    });

    it('is idempotent when already CONFIRMED', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );
      const result = await service.confirmBooking(BUSINESS_ID, BOOKING_ID);
      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(repository.updateBooking).not.toHaveBeenCalled();
    });

    it('rejects confirming a CANCELLED booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      await expect(service.confirmBooking(BUSINESS_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFound for a missing booking', async () => {
      repository.findBookingById.mockResolvedValue(null);
      await expect(service.confirmBooking(BUSINESS_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── cancel ───

  describe('cancelBooking', () => {
    it('cancels a confirmed booking and emits booking.cancelled', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );

      const result = await service.cancelBooking(BUSINESS_ID, BOOKING_ID, {
        reason: 'client request',
        cancelledBy: BookingActor.CLIENT,
      });

      expect(result.status).toBe(BookingStatus.CANCELLED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.cancelled',
        expect.objectContaining({ cancelledBy: BookingActor.CLIENT }),
      );
    });

    it('rejects cancelling an already-cancelled booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      await expect(
        service.cancelBooking(BUSINESS_ID, BOOKING_ID, { reason: 'x' }),
      ).rejects.toThrow(/already cancelled/);
    });

    it('cancels the whole series when cancelSeries is set', async () => {
      const seriesBooking = mockBooking({ recurrence_id: RECURRENCE_ID });
      repository.findBookingById.mockResolvedValue(seriesBooking as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      repository.findBookingsByRecurrence.mockResolvedValue([
        mockBooking({ id: 'sib-1', status: BookingStatus.CONFIRMED }) as never,
        mockBooking({ id: 'sib-2', status: BookingStatus.CANCELLED }) as never, // skipped
      ]);

      await service.cancelBooking(BUSINESS_ID, BOOKING_ID, {
        reason: 'series cancel',
        cancelSeries: true,
      });

      expect(repository.deactivateRecurrence).toHaveBeenCalledWith(
        BUSINESS_ID,
        RECURRENCE_ID,
      );
      // sib-1 (active) cancelled + the target booking; sib-2 already cancelled → skipped.
      const cancelUpdates = repository.updateBooking.mock.calls.filter(
        (c) => (c[2] as { status?: string }).status === BookingStatus.CANCELLED,
      );
      expect(cancelUpdates.length).toBe(2);
    });

    it('removes the Google Calendar event on cancellation', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ gcal_event_id: 'evt-1', gcal_calendar_id: 'primary' }) as never,
      );
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED, gcal_event_id: 'evt-1', gcal_calendar_id: 'primary' }) as never,
      );
      repository.findConnection.mockResolvedValue(mockConnection() as never);

      await service.cancelBooking(BUSINESS_ID, BOOKING_ID, { reason: 'x' });

      expect(googleCalendar.deleteEvent).toHaveBeenCalledWith(
        'at-valid',
        'primary',
        'evt-1',
      );
    });
  });

  // ─── reschedule ───

  describe('rescheduleBooking', () => {
    it('moves a booking to a new time and emits booking.rescheduled', async () => {
      const original = mockBooking();
      repository.findBookingById.mockResolvedValue(original as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({
          status: BookingStatus.RESCHEDULED,
          start_at: new Date('2030-06-28T09:00:00Z'),
          end_at: new Date('2030-06-28T09:30:00Z'),
        }) as never,
      );

      const result = await service.rescheduleBooking(BUSINESS_ID, BOOKING_ID, {
        newStartAt: '2030-06-28T09:00:00.000Z',
      });

      expect(result.status).toBe(BookingStatus.RESCHEDULED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.rescheduled',
        expect.objectContaining({
          oldStartAt: FUTURE_START,
          newStartAt: '2030-06-28T09:00:00.000Z',
        }),
      );
    });

    it('rejects rescheduling a cancelled booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      await expect(
        service.rescheduleBooking(BUSINESS_ID, BOOKING_ID, {
          newStartAt: '2030-06-28T09:00:00Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects rescheduling into a fully-booked slot', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      repository.countOverlapping.mockResolvedValue(1); // capacity 1, already taken
      await expect(
        service.rescheduleBooking(BUSINESS_ID, BOOKING_ID, {
          newStartAt: '2030-06-28T09:00:00Z',
        }),
      ).rejects.toThrow(/fully booked/);
    });
  });

  // ─── complete / no-show ───

  describe('completeBooking & markNoShow', () => {
    it('marks a booking COMPLETED', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.COMPLETED }) as never,
      );
      const result = await service.completeBooking(BUSINESS_ID, BOOKING_ID);
      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.completed',
        expect.objectContaining({ type: 'booking.completed' }),
      );
    });

    it('refuses to complete a cancelled booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      await expect(service.completeBooking(BUSINESS_ID, BOOKING_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('marks a booking NO_SHOW', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.NO_SHOW }) as never,
      );
      const result = await service.markNoShow(BUSINESS_ID, BOOKING_ID);
      expect(result.status).toBe(BookingStatus.NO_SHOW);
    });
  });

  // ─── availability & slots ───

  describe('getAvailableSlots', () => {
    it('returns [] when no availability template exists', async () => {
      repository.findAvailability.mockResolvedValue(null);
      const slots = await service.getAvailableSlots(BUSINESS_ID, {
        from: '2030-06-27T00:00:00Z',
        to: '2030-06-28T00:00:00Z',
        durationMinutes: 30,
      });
      expect(slots).toEqual([]);
    });

    it('computes 30-minute slots within business hours', async () => {
      repository.findAvailability.mockResolvedValue(mockAvailability() as never);

      const slots = await service.getAvailableSlots(BUSINESS_ID, {
        from: '2030-06-27T00:00:00Z',
        to: '2030-06-28T00:00:00Z',
        durationMinutes: 30,
      });

      expect(slots.length).toBeGreaterThan(0);
      // Each slot is 30 minutes and has capacity.
      for (const slot of slots) {
        const dur =
          new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime();
        expect(dur).toBe(30 * 60_000);
        expect(slot.available).toBe(1);
      }
      // 09:00–10:00 IST with a 30-min slot → starts at 09:00 and 09:30 IST.
      // 09:00 IST == 03:30 UTC, 09:30 IST == 04:00 UTC.
      const utcStarts = slots.map((s) => s.startAt);
      expect(utcStarts).toContain('2030-06-27T03:30:00.000Z');
      expect(utcStarts).toContain('2030-06-27T04:00:00.000Z');
    });

    it('excludes slots already occupied to capacity', async () => {
      repository.findAvailability.mockResolvedValue(mockAvailability() as never);
      // An existing booking fills the 09:00 IST (03:30 UTC) slot.
      repository.findActiveBookingsInRange.mockResolvedValue([
        mockBooking({
          start_at: new Date('2030-06-27T03:30:00Z'),
          end_at: new Date('2030-06-27T04:00:00Z'),
        }) as never,
      ]);

      const slots = await service.getAvailableSlots(BUSINESS_ID, {
        from: '2030-06-27T00:00:00Z',
        to: '2030-06-28T00:00:00Z',
        durationMinutes: 30,
      });

      const utcStarts = slots.map((s) => s.startAt);
      expect(utcStarts).not.toContain('2030-06-27T03:30:00.000Z'); // taken
      expect(utcStarts).toContain('2030-06-27T04:00:00.000Z'); // free
    });

    it('still offers a slot when capacity exceeds existing bookings', async () => {
      repository.findAvailability.mockResolvedValue(
        mockAvailability({ capacity_per_slot: 2 }) as never,
      );
      repository.findActiveBookingsInRange.mockResolvedValue([
        mockBooking({
          start_at: new Date('2030-06-27T03:30:00Z'),
          end_at: new Date('2030-06-27T04:00:00Z'),
        }) as never,
      ]);

      const slots = await service.getAvailableSlots(BUSINESS_ID, {
        from: '2030-06-27T00:00:00Z',
        to: '2030-06-28T00:00:00Z',
        durationMinutes: 30,
      });

      const slot = slots.find((s) => s.startAt === '2030-06-27T03:30:00.000Z');
      expect(slot?.available).toBe(1); // capacity 2 − 1 taken
    });

    it('rejects an inverted range', async () => {
      await expect(
        service.getAvailableSlots(BUSINESS_ID, {
          from: '2030-06-28T00:00:00Z',
          to: '2030-06-27T00:00:00Z',
          durationMinutes: 30,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── blocks ───

  describe('blockSlot & unblockSlot', () => {
    it('creates a block', async () => {
      repository.createBlock.mockResolvedValue({
        id: 'blk-1',
        business_id: BUSINESS_ID,
        staff_id: null,
        start_at: new Date('2030-07-01T00:00:00Z'),
        end_at: new Date('2030-07-01T06:00:00Z'),
        reason: 'holiday',
      } as never);

      const result = await service.blockSlot(BUSINESS_ID, {
        startAt: '2030-07-01T00:00:00Z',
        endAt: '2030-07-01T06:00:00Z',
        reason: 'holiday',
      });
      expect(result.id).toBe('blk-1');
      expect(result.reason).toBe('holiday');
    });

    it('rejects a block whose end is before its start', async () => {
      await expect(
        service.blockSlot(BUSINESS_ID, {
          startAt: '2030-07-01T06:00:00Z',
          endAt: '2030-07-01T00:00:00Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('removes a block', async () => {
      repository.deleteBlock.mockResolvedValue(undefined);
      await service.unblockSlot(BUSINESS_ID, 'blk-1');
      expect(repository.deleteBlock).toHaveBeenCalledWith(BUSINESS_ID, 'blk-1');
    });
  });

  describe('setAvailability', () => {
    it('persists the weekly template', async () => {
      repository.upsertAvailability.mockResolvedValue(mockAvailability() as never);
      const result = await service.setAvailability(BUSINESS_ID, {
        weeklyHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1080 }],
        slotIntervalMinutes: 30,
      });
      expect(result.businessId).toBe(BUSINESS_ID);
      expect(repository.upsertAvailability).toHaveBeenCalled();
    });

    it('rejects a window with end before start', async () => {
      await expect(
        service.setAvailability(BUSINESS_ID, {
          weeklyHours: [{ dayOfWeek: 1, startMinute: 600, endMinute: 540 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── reminders ───

  describe('scheduleReminders & fireReminder', () => {
    it('schedules 24h + 1h reminder jobs for a future booking', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      await service.scheduleReminders(BUSINESS_ID, BOOKING_ID);
      const reminders = queue.add.mock.calls.filter(
        (c) => c[0] === BOOKING_JOBS.REMINDER,
      );
      expect(reminders).toHaveLength(2);
      expect(reminders.map((c) => c[1].minutesBefore).sort((a, b) => a - b)).toEqual([
        60, 1440,
      ]);
    });

    /**
     * The jobIds are derived from the booking, so they survive a reschedule —
     * and Bull's addJob script returns early when the id already exists rather
     * than replacing the job. Re-arming without clearing first was therefore a
     * silent no-op, leaving the reminders pointed at the booking's original
     * start time.
     */
    it('clears the booking stale reminder jobs before re-arming them', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);

      await service.scheduleReminders(BUSINESS_ID, BOOKING_ID);

      expect(queue.removeJobs).toHaveBeenCalledWith(`reminder:${BOOKING_ID}:*`);
      // The clear has to precede the adds, or it removes what it just scheduled.
      expect(queue.removeJobs.mock.invocationCallOrder[0]).toBeLessThan(
        queue.add.mock.invocationCallOrder[0]!,
      );
    });

    it('does not clear reminders for a booking that no longer exists', async () => {
      repository.findBookingById.mockResolvedValue(null as never);

      await service.scheduleReminders(BUSINESS_ID, BOOKING_ID);

      expect(queue.removeJobs).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    /**
     * The reschedule is already committed by the time reminders are re-armed, so
     * a Redis failure here must not surface as a failed reschedule.
     */
    it('still schedules the new reminders when clearing the old ones fails', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      queue.removeJobs.mockRejectedValue(new Error('redis unreachable'));

      await expect(
        service.scheduleReminders(BUSINESS_ID, BOOKING_ID),
      ).resolves.toBeUndefined();

      const reminders = queue.add.mock.calls.filter(
        (c) => c[0] === BOOKING_JOBS.REMINDER,
      );
      expect(reminders).toHaveLength(2);
    });

    it('skips reminders that would fire in the past', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ start_at: new Date('2020-01-01T09:00:00Z') }) as never,
      );
      await service.scheduleReminders(BUSINESS_ID, BOOKING_ID);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fires a reminder event for an active booking', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      repository.updateBooking.mockResolvedValue(mockBooking() as never);
      await service.fireReminder(BUSINESS_ID, BOOKING_ID, 60);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.reminder',
        expect.objectContaining({ minutesBefore: 60 }),
      );
      expect(repository.updateBooking).toHaveBeenCalledWith(
        BUSINESS_ID,
        BOOKING_ID,
        expect.objectContaining({ reminders_sent: { increment: 1 } }),
      );
    });

    it('does not fire a reminder for a cancelled booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      await service.fireReminder(BUSINESS_ID, BOOKING_ID, 60);
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'booking.reminder',
        expect.anything(),
      );
    });
  });

  describe('autoCancelIfUnpaid', () => {
    it('cancels a still-PENDING booking', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.PENDING }) as never,
      );
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CANCELLED }) as never,
      );
      await service.autoCancelIfUnpaid(BUSINESS_ID, BOOKING_ID);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.cancelled',
        expect.objectContaining({ cancelledBy: BookingActor.SYSTEM }),
      );
    });

    it('leaves a CONFIRMED booking untouched', async () => {
      repository.findBookingById.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );
      await service.autoCancelIfUnpaid(BUSINESS_ID, BOOKING_ID);
      expect(repository.updateBooking).not.toHaveBeenCalled();
    });
  });

  // ─── payment.success listener ───

  describe('handlePaymentSuccess', () => {
    it('auto-confirms a PENDING booking referenced by the payment', async () => {
      const pending = mockBooking({ status: BookingStatus.PENDING });
      repository.findBookingById.mockResolvedValue(pending as never);
      repository.updateBooking.mockResolvedValue(
        mockBooking({ status: BookingStatus.CONFIRMED }) as never,
      );

      const event = {
        type: 'payment.success',
        id: 'e1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'c1',
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
      } as PaymentSuccessEvent & { bookingId: string };

      await service.handlePaymentSuccess(event);

      expect(repository.updateBooking).toHaveBeenCalledWith(
        BUSINESS_ID,
        BOOKING_ID,
        expect.objectContaining({ payment_id: PAYMENT_ID }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'booking.confirmed',
        expect.anything(),
      );
    });

    it('ignores a payment event with no bookingId', async () => {
      await service.handlePaymentSuccess({
        type: 'payment.success',
        id: 'e1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'c1',
        paymentId: PAYMENT_ID,
      } as PaymentSuccessEvent);
      expect(repository.findBookingById).not.toHaveBeenCalled();
    });
  });

  // ─── Google Calendar ───

  describe('Google Calendar', () => {
    it('builds an auth URL encoding the tenant in state', () => {
      const result = service.getGoogleAuthUrl(BUSINESS_ID, STAFF_ID);
      expect(googleCalendar.getAuthUrl).toHaveBeenCalledWith(
        `${BUSINESS_ID}:${STAFF_ID}`,
        undefined,
      );
      expect(result.url).toBe('https://consent');
    });

    it('connects a calendar by exchanging the code and storing tokens', async () => {
      googleCalendar.exchangeCode.mockResolvedValue({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: new Date(Date.now() + 3600_000),
        scope: 'calendar.events',
      });
      repository.upsertConnection.mockResolvedValue(mockConnection() as never);

      const result = await service.connectGoogleCalendar(BUSINESS_ID, {
        authCode: 'code-1',
      });

      expect(result.connected).toBe(true);
      expect(repository.upsertConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        null,
        expect.objectContaining({ refreshToken: 'rt-1' }),
      );
    });

    it('syncs future bookings and stamps last_synced_at', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      repository.findBookings.mockResolvedValue({
        data: [mockBooking() as never],
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      });
      googleCalendar.createEvent.mockResolvedValue({
        eventId: 'evt-1',
        status: 'confirmed',
      });
      repository.updateBooking.mockResolvedValue(mockBooking() as never);
      repository.updateConnection.mockResolvedValue(mockConnection() as never);

      const result = await service.syncGoogleCalendar(BUSINESS_ID);

      expect(result.synced).toBe(1);
      expect(googleCalendar.createEvent).toHaveBeenCalled();
      expect(repository.updateConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        'conn-1',
        expect.objectContaining({ last_synced_at: expect.any(Date) }),
      );
    });

    it('raises a HITL task when token refresh fails during sync', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({
          token_expires_at: new Date(Date.now() - 1000), // expired
          refresh_token: null, // cannot refresh
        }) as never,
      );

      await expect(service.syncGoogleCalendar(BUSINESS_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({ type: 'task.created' }),
      );
    });

    it('refreshes an expired token before pushing events', async () => {
      repository.findConnection.mockResolvedValue(
        mockConnection({ token_expires_at: new Date(Date.now() - 1000) }) as never,
      );
      googleCalendar.refreshAccessToken.mockResolvedValue({
        accessToken: 'at-refreshed',
        refreshToken: 'rt-1',
        expiresAt: new Date(Date.now() + 3600_000),
        scope: 'calendar.events',
      });
      repository.findBookings.mockResolvedValue({
        data: [mockBooking() as never],
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      });
      googleCalendar.createEvent.mockResolvedValue({
        eventId: 'evt-1',
        status: 'confirmed',
      });
      repository.updateBooking.mockResolvedValue(mockBooking() as never);
      repository.updateConnection.mockResolvedValue(mockConnection() as never);

      await service.syncGoogleCalendar(BUSINESS_ID);

      expect(googleCalendar.refreshAccessToken).toHaveBeenCalledWith('rt-1');
      expect(googleCalendar.createEvent).toHaveBeenCalledWith(
        'at-refreshed',
        'primary',
        expect.anything(),
      );
    });

    it('disconnects a calendar', async () => {
      repository.findConnection.mockResolvedValue(mockConnection() as never);
      repository.deleteConnection.mockResolvedValue(undefined);
      await service.disconnectGoogleCalendar(BUSINESS_ID);
      expect(repository.deleteConnection).toHaveBeenCalledWith(BUSINESS_ID, 'conn-1');
    });
  });

  // ─── retrieval ───

  describe('getBooking & listBookings', () => {
    it('returns a booking DTO', async () => {
      repository.findBookingById.mockResolvedValue(mockBooking() as never);
      const result = await service.getBooking(BUSINESS_ID, BOOKING_ID);
      expect(result.id).toBe(BOOKING_ID);
    });

    it('throws NotFound for a missing booking', async () => {
      repository.findBookingById.mockResolvedValue(null);
      await expect(service.getBooking(BUSINESS_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lists bookings with pagination metadata', async () => {
      repository.findBookings.mockResolvedValue({
        data: [mockBooking() as never],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
      const result = await service.listBookings(BUSINESS_ID, {});
      expect(result.total).toBe(1);
      expect(result.data[0]!.id).toBe(BOOKING_ID);
    });
  });
});
