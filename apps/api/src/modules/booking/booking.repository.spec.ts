/**
 * BookingRepository unit tests.
 *
 * The thing worth protecting here is `createBookingAtomic`: the overlap count
 * and the insert must happen inside one transaction, and the overlap predicate
 * itself (`existing.start < end AND existing.end > start`, active statuses
 * only) is what stops a double booking. Both are asserted directly rather than
 * inferred from a successful create.
 *
 * The rest is optional-field surface that behaves differently on the empty
 * case than the populated one:
 *
 *   - `findBookings` builds an optional `where`, and its date range has to
 *     degrade to a half-open range when only one bound is given.
 *   - `findAvailability` falls back from a per-staff template to the
 *     business-wide default, but only after a per-staff miss.
 *   - `upsertAvailability` / `upsertConnection` branch on an existing row.
 *   - `findBlocksInRange` ORs a business-wide block against a staff-specific
 *     one; the staff arm must disappear entirely for a business-wide query.
 *
 * Every query must carry `business_id`; that is asserted throughout.
 *
 * PrismaService is mocked — assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { BookingStatus, ResourceNotFoundError } from '@gosumo/shared';

import {
  BookingRepository,
  type CreateBookingData,
} from './booking.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CLIENT_ID = '00000000-0000-4000-b000-000000000001';
const BOOKING_ID = '00000000-0000-4000-c000-000000000001';
const STAFF_ID = '00000000-0000-4000-d000-000000000001';
const BLOCK_ID = '00000000-0000-4000-e000-000000000001';
const RECURRENCE_ID = '00000000-0000-4000-f000-000000000001';
const AVAILABILITY_ID = '00000000-0000-4000-a000-000000000009';
const CONNECTION_ID = '00000000-0000-4000-a000-000000000010';

const START = new Date('2026-07-01T09:00:00Z');
const END = new Date('2026-07-01T10:00:00Z');

function bookingData(
  overrides: Partial<CreateBookingData> = {},
): CreateBookingData {
  return {
    businessId: BUSINESS_ID,
    clientId: CLIENT_ID,
    status: BookingStatus.PENDING,
    startAt: START,
    endAt: END,
    timezone: 'Asia/Kolkata',
    durationMinutes: 60,
    ...overrides,
  };
}

describe('BookingRepository', () => {
  let repository: BookingRepository;
  let tx: {
    bookings: { count: jest.Mock; create: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    bookings: {
      count: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    booking_availability: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    booking_blocked_slots: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    booking_calendar_connections: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    booking_recurrences: {
      findFirst: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    tx = {
      bookings: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: BOOKING_ID }),
      },
    };

    prisma = {
      $transaction: jest.fn(
        (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      ),
      bookings: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: BOOKING_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: BOOKING_ID }),
      },
      booking_availability: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: AVAILABILITY_ID }),
        update: jest.fn().mockResolvedValue({ id: AVAILABILITY_ID }),
      },
      booking_blocked_slots: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: BLOCK_ID }),
        update: jest.fn().mockResolvedValue({ id: BLOCK_ID }),
      },
      booking_calendar_connections: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: CONNECTION_ID }),
        update: jest.fn().mockResolvedValue({ id: CONNECTION_ID }),
      },
      booking_recurrences: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: RECURRENCE_ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(BookingRepository);
  });

  describe('createBookingAtomic — the double-booking guard', () => {
    it('counts and inserts inside a single transaction', async () => {
      await repository.createBookingAtomic(bookingData(), 1);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.bookings.count).toHaveBeenCalledTimes(1);
      expect(tx.bookings.create).toHaveBeenCalledTimes(1);
      // The non-transactional client must not be touched for either step.
      expect(prisma.bookings.count).not.toHaveBeenCalled();
      expect(prisma.bookings.create).not.toHaveBeenCalled();
    });

    it('counts only active bookings that genuinely overlap the slot', async () => {
      await repository.createBookingAtomic(
        bookingData({ staffId: STAFF_ID }),
        1,
      );

      expect(tx.bookings.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          staff_id: STAFF_ID,
          deleted_at: null,
          status: {
            in: [
              BookingStatus.PENDING,
              BookingStatus.CONFIRMED,
              BookingStatus.RESCHEDULED,
              BookingStatus.COMPLETED,
            ],
          },
          start_at: { lt: END },
          end_at: { gt: START },
        },
      });
    });

    it('rejects when the slot is already at capacity', async () => {
      tx.bookings.count.mockResolvedValue(1);

      await expect(
        repository.createBookingAtomic(bookingData(), 1),
      ).rejects.toThrow(ConflictException);
      expect(tx.bookings.create).not.toHaveBeenCalled();
    });

    it('rejects when the count has somehow overshot capacity', async () => {
      tx.bookings.count.mockResolvedValue(5);

      await expect(
        repository.createBookingAtomic(bookingData(), 3),
      ).rejects.toThrow(ConflictException);
    });

    it('accepts a concurrent booking while capacity remains', async () => {
      tx.bookings.count.mockResolvedValue(2);

      await expect(
        repository.createBookingAtomic(bookingData(), 3),
      ).resolves.toEqual({ id: BOOKING_ID });
    });

    it('names the staff member in the conflict when the slot is staff-scoped', async () => {
      tx.bookings.count.mockResolvedValue(1);

      await expect(
        repository.createBookingAtomic(
          bookingData({ staffId: STAFF_ID }),
          1,
        ),
      ).rejects.toThrow(new RegExp(`for staff ${STAFF_ID}`));
    });

    it('omits the staff clause from a business-wide conflict message', async () => {
      tx.bookings.count.mockResolvedValue(1);

      await expect(
        repository.createBookingAtomic(bookingData(), 1),
      ).rejects.toThrow(/fully booked \(capacity 1\)/);
    });

    it('nulls every unsupplied optional column', async () => {
      await repository.createBookingAtomic(bookingData(), 1);

      const { data } = tx.bookings.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
        catalog_item_id: null,
        staff_id: null,
        recurrence_id: null,
        location_type: null,
        location_address: null,
        meeting_url: null,
        price: null,
        deposit_amount: null,
        notes: null,
      });
      expect(data.metadata).toEqual({});
    });

    it('persists every supplied optional column', async () => {
      await repository.createBookingAtomic(
        bookingData({
          catalogItemId: 'item-1',
          staffId: STAFF_ID,
          recurrenceId: RECURRENCE_ID,
          locationType: 'IN_PERSON',
          locationAddress: 'Bandra, Mumbai',
          meetingUrl: 'https://meet.example.com/x',
          price: 1500,
          depositAmount: 500,
          notes: 'First visit',
        }),
        1,
      );

      const { data } = tx.bookings.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        catalog_item_id: 'item-1',
        staff_id: STAFF_ID,
        recurrence_id: RECURRENCE_ID,
        location_type: 'IN_PERSON',
        location_address: 'Bandra, Mumbai',
        meeting_url: 'https://meet.example.com/x',
        price: 1500,
        deposit_amount: 500,
        notes: 'First visit',
      });
    });

    it('folds the conversation id into metadata alongside the caller metadata', async () => {
      await repository.createBookingAtomic(
        bookingData({
          metadata: { source: 'whatsapp' },
          conversationId: 'conv-1',
        }),
        1,
      );

      const { data } = tx.bookings.create.mock.calls[0]![0];
      expect(data.metadata).toEqual({
        source: 'whatsapp',
        conversationId: 'conv-1',
      });
    });

    it('leaves metadata free of a conversation key when there is no conversation', async () => {
      await repository.createBookingAtomic(
        bookingData({ metadata: { source: 'walk-in' } }),
        1,
      );

      const { data } = tx.bookings.create.mock.calls[0]![0];
      expect(data.metadata).toEqual({ source: 'walk-in' });
      expect(data.metadata).not.toHaveProperty('conversationId');
    });
  });

  describe('countOverlapping', () => {
    it('excludes a booking being rescheduled from its own overlap check', async () => {
      await repository.countOverlapping(
        BUSINESS_ID,
        STAFF_ID,
        START,
        END,
        BOOKING_ID,
      );

      const { where } = prisma.bookings.count.mock.calls[0]![0];
      expect(where.id).toEqual({ not: BOOKING_ID });
      expect(where.business_id).toBe(BUSINESS_ID);
    });

    it('omits the id exclusion when no booking is being excluded', async () => {
      await repository.countOverlapping(BUSINESS_ID, null, START, END);

      const { where } = prisma.bookings.count.mock.calls[0]![0];
      expect(where).not.toHaveProperty('id');
      expect(where.staff_id).toBeNull();
    });
  });

  describe('findActiveBookingsInRange', () => {
    it('scopes to a staff member when one is given', async () => {
      await repository.findActiveBookingsInRange(
        BUSINESS_ID,
        STAFF_ID,
        START,
        END,
      );

      const { where, orderBy } = prisma.bookings.findMany.mock.calls[0]![0];
      expect(where.staff_id).toBe(STAFF_ID);
      expect(where.start_at).toEqual({ lt: END });
      expect(where.end_at).toEqual({ gt: START });
      expect(orderBy).toEqual({ start_at: 'asc' });
    });

    it('spans every staff member when none is given', async () => {
      await repository.findActiveBookingsInRange(BUSINESS_ID, null, START, END);

      const { where } = prisma.bookings.findMany.mock.calls[0]![0];
      expect(where).not.toHaveProperty('staff_id');
      expect(where.business_id).toBe(BUSINESS_ID);
    });
  });

  describe('findBookingById', () => {
    it('scopes to the tenant, skips soft-deleted rows, and joins the client', async () => {
      await repository.findBookingById(BUSINESS_ID, BOOKING_ID);

      expect(prisma.bookings.findFirst).toHaveBeenCalledWith({
        where: { id: BOOKING_ID, business_id: BUSINESS_ID, deleted_at: null },
        include: { client: true },
      });
    });
  });

  describe('findBookings', () => {
    async function whereFor(
      filters: Parameters<BookingRepository['findBookings']>[1],
    ): Promise<Record<string, unknown>> {
      await repository.findBookings(BUSINESS_ID, filters);
      return prisma.bookings.findMany.mock.calls[0]![0].where as Record<
        string,
        unknown
      >;
    }

    it('defaults to page 1 with a limit of 20', async () => {
      const result = await repository.findBookings(BUSINESS_ID, {});

      expect(prisma.bookings.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('omits every unsupplied filter', async () => {
      const where = await whereFor({});

      expect(where).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('applies status, client, and staff filters', async () => {
      const where = await whereFor({
        status: BookingStatus.CONFIRMED,
        clientId: CLIENT_ID,
        staffId: STAFF_ID,
      });

      expect(where).toMatchObject({
        status: BookingStatus.CONFIRMED,
        client_id: CLIENT_ID,
        staff_id: STAFF_ID,
      });
    });

    it('builds a closed date range from both bounds', async () => {
      const where = await whereFor({ from: START, to: END });

      expect(where.start_at).toEqual({ gte: START, lte: END });
    });

    it('builds a half-open range from a lower bound alone', async () => {
      const where = await whereFor({ from: START });

      expect(where.start_at).toEqual({ gte: START });
    });

    it('builds a half-open range from an upper bound alone', async () => {
      const where = await whereFor({ to: END });

      expect(where.start_at).toEqual({ lte: END });
    });

    it('paginates and reports the page count', async () => {
      prisma.bookings.count.mockResolvedValue(45);

      const result = await repository.findBookings(BUSINESS_ID, {
        page: 3,
        limit: 10,
      });

      expect(prisma.bookings.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result.totalPages).toBe(5);
    });

    it('counts against the same where clause it lists with', async () => {
      await repository.findBookings(BUSINESS_ID, { staffId: STAFF_ID });

      expect(prisma.bookings.count.mock.calls[0]![0].where).toEqual(
        prisma.bookings.findMany.mock.calls[0]![0].where,
      );
    });
  });

  describe('findBookingsByRecurrence', () => {
    it('returns the whole series when no cutoff is given', async () => {
      await repository.findBookingsByRecurrence(BUSINESS_ID, RECURRENCE_ID);

      const { where } = prisma.bookings.findMany.mock.calls[0]![0];
      expect(where).toEqual({
        business_id: BUSINESS_ID,
        recurrence_id: RECURRENCE_ID,
        deleted_at: null,
      });
    });

    it('limits to future occurrences when a cutoff is given', async () => {
      await repository.findBookingsByRecurrence(
        BUSINESS_ID,
        RECURRENCE_ID,
        START,
      );

      const { where } = prisma.bookings.findMany.mock.calls[0]![0];
      expect(where.start_at).toEqual({ gte: START });
    });
  });

  describe('updateBooking', () => {
    it('re-reads under the tenant scope before writing', async () => {
      prisma.bookings.findFirst.mockResolvedValue({ id: BOOKING_ID });

      await repository.updateBooking(BUSINESS_ID, BOOKING_ID, {
        status: BookingStatus.CONFIRMED,
      });

      expect(prisma.bookings.findFirst).toHaveBeenCalledWith({
        where: { id: BOOKING_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
      expect(prisma.bookings.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID, business_id: BUSINESS_ID },
        data: { status: BookingStatus.CONFIRMED },
        include: { client: true },
      });
    });

    it('refuses to write when the id belongs to another tenant', async () => {
      prisma.bookings.findFirst.mockResolvedValue(null);

      await expect(
        repository.updateBooking(BUSINESS_ID, BOOKING_ID, {
          status: BookingStatus.CANCELLED,
        }),
      ).rejects.toThrow(ResourceNotFoundError);
      expect(prisma.bookings.update).not.toHaveBeenCalled();
    });
  });

  describe('findByPaymentId', () => {
    it('scopes the payment lookup to the tenant', async () => {
      await repository.findByPaymentId(BUSINESS_ID, 'pay_123');

      expect(prisma.bookings.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          payment_id: 'pay_123',
          deleted_at: null,
        },
      });
    });
  });

  describe('findAvailability', () => {
    it('prefers a per-staff template when one exists', async () => {
      prisma.booking_availability.findFirst.mockResolvedValue({
        id: AVAILABILITY_ID,
        staff_id: STAFF_ID,
      });

      const result = await repository.findAvailability(BUSINESS_ID, STAFF_ID);

      expect(result).toMatchObject({ staff_id: STAFF_ID });
      expect(prisma.booking_availability.findFirst).toHaveBeenCalledTimes(1);
    });

    it('falls back to the business-wide default after a per-staff miss', async () => {
      prisma.booking_availability.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: AVAILABILITY_ID, staff_id: null });

      const result = await repository.findAvailability(BUSINESS_ID, STAFF_ID);

      expect(result).toMatchObject({ staff_id: null });
      expect(prisma.booking_availability.findFirst).toHaveBeenCalledTimes(2);
      expect(prisma.booking_availability.findFirst).toHaveBeenLastCalledWith({
        where: { business_id: BUSINESS_ID, staff_id: null, deleted_at: null },
      });
    });

    it('goes straight to the business-wide default when no staff is given', async () => {
      await repository.findAvailability(BUSINESS_ID, null);

      expect(prisma.booking_availability.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.booking_availability.findFirst).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, staff_id: null, deleted_at: null },
      });
    });
  });

  describe('upsertAvailability', () => {
    const payload = {
      timezone: 'Asia/Kolkata',
      weeklyHours: { mon: [['09:00', '17:00']] },
      slotIntervalMinutes: 30,
      bufferMinutes: 10,
      minNoticeMinutes: 60,
      maxAdvanceDays: 30,
      capacityPerSlot: 1,
    };

    it('updates the existing template in place', async () => {
      prisma.booking_availability.findFirst.mockResolvedValue({
        id: AVAILABILITY_ID,
      });

      await repository.upsertAvailability(BUSINESS_ID, STAFF_ID, payload);

      expect(prisma.booking_availability.update).toHaveBeenCalledWith({
        where: { id: AVAILABILITY_ID, business_id: BUSINESS_ID },
        data: expect.objectContaining({
          timezone: 'Asia/Kolkata',
          slot_interval_minutes: 30,
          is_active: true,
        }),
      });
      expect(prisma.booking_availability.create).not.toHaveBeenCalled();
    });

    it('creates a template when the scope has none', async () => {
      prisma.booking_availability.findFirst.mockResolvedValue(null);

      await repository.upsertAvailability(BUSINESS_ID, null, payload);

      expect(prisma.booking_availability.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          staff_id: null,
          capacity_per_slot: 1,
        }),
      });
      expect(prisma.booking_availability.update).not.toHaveBeenCalled();
    });
  });

  describe('listAvailability', () => {
    it('lists live templates for the tenant oldest-first', async () => {
      await repository.listAvailability(BUSINESS_ID);

      expect(prisma.booking_availability.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { created_at: 'asc' },
      });
    });
  });

  describe('blocked slots', () => {
    it('createBlock nulls an absent reason', async () => {
      await repository.createBlock(BUSINESS_ID, {
        staffId: null,
        startAt: START,
        endAt: END,
      });

      expect(prisma.booking_blocked_slots.create).toHaveBeenCalledWith({
        data: {
          business_id: BUSINESS_ID,
          staff_id: null,
          start_at: START,
          end_at: END,
          reason: null,
        },
      });
    });

    it('createBlock keeps a supplied reason and staff scope', async () => {
      await repository.createBlock(BUSINESS_ID, {
        staffId: STAFF_ID,
        startAt: START,
        endAt: END,
        reason: 'Diwali holiday',
      });

      const { data } = prisma.booking_blocked_slots.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        staff_id: STAFF_ID,
        reason: 'Diwali holiday',
      });
    });

    it('deleteBlock soft-deletes after a tenant-scoped re-read', async () => {
      prisma.booking_blocked_slots.findFirst.mockResolvedValue({
        id: BLOCK_ID,
      });

      await repository.deleteBlock(BUSINESS_ID, BLOCK_ID);

      const call = prisma.booking_blocked_slots.update.mock.calls[0]![0];
      expect(call.where).toEqual({ id: BLOCK_ID, business_id: BUSINESS_ID });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });

    it('deleteBlock refuses an id belonging to another tenant', async () => {
      prisma.booking_blocked_slots.findFirst.mockResolvedValue(null);

      await expect(
        repository.deleteBlock(BUSINESS_ID, BLOCK_ID),
      ).rejects.toThrow(ResourceNotFoundError);
      expect(prisma.booking_blocked_slots.update).not.toHaveBeenCalled();
    });

    it('findBlocksInRange ORs the staff block against the business-wide one', async () => {
      await repository.findBlocksInRange(BUSINESS_ID, STAFF_ID, START, END);

      const { where } = prisma.booking_blocked_slots.findMany.mock.calls[0]![0];
      expect(where.OR).toEqual([{ staff_id: null }, { staff_id: STAFF_ID }]);
      expect(where.start_at).toEqual({ lt: END });
      expect(where.end_at).toEqual({ gt: START });
    });

    it('findBlocksInRange drops the staff arm for a business-wide query', async () => {
      await repository.findBlocksInRange(BUSINESS_ID, null, START, END);

      const { where } = prisma.booking_blocked_slots.findMany.mock.calls[0]![0];
      expect(where.OR).toEqual([{ staff_id: null }]);
    });
  });

  describe('calendar connections', () => {
    const connectionPayload = {
      provider: 'google',
      googleCalendarId: 'cal-1',
      accessToken: 'at',
      refreshToken: 'rt',
      tokenExpiresAt: END,
      scope: 'calendar',
    };

    it('findConnection defaults the provider to google', async () => {
      await repository.findConnection(BUSINESS_ID, STAFF_ID);

      expect(
        prisma.booking_calendar_connections.findFirst,
      ).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          staff_id: STAFF_ID,
          provider: 'google',
          deleted_at: null,
        },
      });
    });

    it('findConnection honours an explicit provider', async () => {
      await repository.findConnection(BUSINESS_ID, null, 'outlook');

      const { where } =
        prisma.booking_calendar_connections.findFirst.mock.calls[0]![0];
      expect(where.provider).toBe('outlook');
    });

    it('upsertConnection updates in place and clears the last sync error', async () => {
      prisma.booking_calendar_connections.findFirst.mockResolvedValue({
        id: CONNECTION_ID,
      });

      await repository.upsertConnection(
        BUSINESS_ID,
        STAFF_ID,
        connectionPayload,
      );

      expect(prisma.booking_calendar_connections.update).toHaveBeenCalledWith({
        where: { id: CONNECTION_ID, business_id: BUSINESS_ID },
        data: expect.objectContaining({
          sync_enabled: true,
          last_sync_error: null,
          google_account_email: null,
        }),
      });
      expect(prisma.booking_calendar_connections.create).not.toHaveBeenCalled();
    });

    it('upsertConnection creates a connection when none exists', async () => {
      prisma.booking_calendar_connections.findFirst.mockResolvedValue(null);

      await repository.upsertConnection(BUSINESS_ID, null, {
        ...connectionPayload,
        googleAccountEmail: 'owner@example.com',
      });

      expect(prisma.booking_calendar_connections.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          staff_id: null,
          provider: 'google',
          google_account_email: 'owner@example.com',
        }),
      });
    });

    it('updateConnection scopes the write to the tenant', async () => {
      await repository.updateConnection(BUSINESS_ID, CONNECTION_ID, {
        last_sync_error: 'token expired',
      });

      expect(prisma.booking_calendar_connections.update).toHaveBeenCalledWith({
        where: { id: CONNECTION_ID, business_id: BUSINESS_ID },
        data: { last_sync_error: 'token expired' },
      });
    });

    it('deleteConnection soft-deletes and stops syncing', async () => {
      await repository.deleteConnection(BUSINESS_ID, CONNECTION_ID);

      const call =
        prisma.booking_calendar_connections.update.mock.calls[0]![0];
      expect(call.where).toEqual({
        id: CONNECTION_ID,
        business_id: BUSINESS_ID,
      });
      expect(call.data.sync_enabled).toBe(false);
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('recurrences', () => {
    const recurrenceInput = {
      businessId: BUSINESS_ID,
      clientId: CLIENT_ID,
      rule: { freq: 'WEEKLY' },
      startAt: START,
      durationMinutes: 60,
      timezone: 'Asia/Kolkata',
    };

    it('createRecurrence nulls every unsupplied optional column', async () => {
      await repository.createRecurrence(recurrenceInput);

      const { data } = prisma.booking_recurrences.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        business_id: BUSINESS_ID,
        catalog_item_id: null,
        staff_id: null,
        location_type: null,
        location_address: null,
        meeting_url: null,
        price: null,
        notes: null,
      });
    });

    it('createRecurrence persists every supplied optional column', async () => {
      await repository.createRecurrence({
        ...recurrenceInput,
        catalogItemId: 'item-1',
        staffId: STAFF_ID,
        locationType: 'ONLINE',
        locationAddress: null,
        meetingUrl: 'https://meet.example.com/y',
        price: 999,
        notes: 'Weekly tutoring',
      });

      const { data } = prisma.booking_recurrences.create.mock.calls[0]![0];
      expect(data).toMatchObject({
        catalog_item_id: 'item-1',
        staff_id: STAFF_ID,
        location_type: 'ONLINE',
        meeting_url: 'https://meet.example.com/y',
        price: 999,
        notes: 'Weekly tutoring',
      });
    });

    it('findRecurrence scopes to the tenant and skips soft-deleted rows', async () => {
      await repository.findRecurrence(BUSINESS_ID, RECURRENCE_ID);

      expect(prisma.booking_recurrences.findFirst).toHaveBeenCalledWith({
        where: {
          id: RECURRENCE_ID,
          business_id: BUSINESS_ID,
          deleted_at: null,
        },
      });
    });

    it('deactivateRecurrence flips is_active under the tenant scope', async () => {
      await repository.deactivateRecurrence(BUSINESS_ID, RECURRENCE_ID);

      expect(prisma.booking_recurrences.updateMany).toHaveBeenCalledWith({
        where: { id: RECURRENCE_ID, business_id: BUSINESS_ID },
        data: { is_active: false },
      });
    });
  });
});
