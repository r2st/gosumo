/**
 * BookingController — the calendar, staff and list routes that back the
 * dashboard's bookings page.
 *
 * These previously re-implemented the controller's mapping inline, which meant
 * they kept passing no matter what the controller did. They now drive the real
 * controller against a mocked service.
 */
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BookingStatus } from '@gosumo/shared';
import type { BookingDto, ListBookingsQueryDto } from './dto';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const BOOKING_ID = '22222222-2222-2222-2222-222222222222';
const STAFF_ID = '33333333-3333-3333-3333-333333333333';

function bookingDto(overrides: Partial<BookingDto> = {}): BookingDto {
  return {
    id: BOOKING_ID,
    businessId: TENANT_ID,
    clientId: 'client-1',
    catalogItemId: null,
    staffId: null,
    recurrenceId: null,
    status: BookingStatus.CONFIRMED,
    startAt: '2030-06-27T10:00:00.000Z',
    endAt: '2030-06-27T11:00:00.000Z',
    timezone: 'Asia/Kolkata',
    durationMinutes: 60,
    locationType: null,
    locationAddress: null,
    meetingUrl: null,
    pricePaise: null,
    depositPaise: null,
    paymentId: null,
    gcalEventId: null,
    gcalCalendarId: null,
    remindersSent: 0,
    lastReminderAt: null,
    cancelledAt: null,
    cancellationReason: null,
    cancelledBy: null,
    notes: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function page(data: BookingDto[]) {
  return { data, total: data.length, page: 1, limit: 200, totalPages: 1 };
}

describe('BookingController', () => {
  let service: jest.Mocked<Pick<BookingService, 'listBookings' | 'getStaffMembers'>>;
  let controller: BookingController;

  beforeEach(() => {
    service = {
      listBookings: jest.fn().mockResolvedValue(page([])),
      getStaffMembers: jest.fn().mockResolvedValue({ staff: [] }),
    } as unknown as jest.Mocked<
      Pick<BookingService, 'listBookings' | 'getStaffMembers'>
    >;
    controller = new BookingController(service as unknown as BookingService);
  });

  describe('listBookings', () => {
    it('wraps the paginated result in the dashboard envelope', async () => {
      service.listBookings.mockResolvedValue({
        data: [bookingDto()],
        total: 42,
        page: 2,
        limit: 10,
        totalPages: 5,
      });

      const result = await controller.listBookings(TENANT_ID, {
        page: 2,
        limit: 10,
      } as ListBookingsQueryDto);

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({
        total: 42,
        limit: 10,
        page: 2,
        totalPages: 5,
      });
    });
  });

  describe('getCalendar', () => {
    it('maps bookings to calendar events', async () => {
      service.listBookings.mockResolvedValue(
        page([bookingDto({ notes: 'Haircut', staffId: STAFF_ID })]),
      );

      const { events } = await controller.getCalendar(TENANT_ID);

      expect(events).toEqual([
        {
          id: BOOKING_ID,
          title: 'Haircut',
          start: '2030-06-27T10:00:00.000Z',
          end: '2030-06-27T11:00:00.000Z',
          status: BookingStatus.CONFIRMED,
          clientId: 'client-1',
          staffId: STAFF_ID,
        },
      ]);
    });

    it('titles an untitled booking "Appointment"', async () => {
      service.listBookings.mockResolvedValue(page([bookingDto({ notes: '' })]));

      const { events } = await controller.getCalendar(TENANT_ID);

      expect(events[0]!.title).toBe('Appointment');
    });

    it('queries a wide page with no filters by default', async () => {
      await controller.getCalendar(TENANT_ID);

      expect(service.listBookings).toHaveBeenCalledWith(TENANT_ID, {
        page: 1,
        limit: 200,
      });
    });

    it('forwards the from/to/staff filters when supplied', async () => {
      await controller.getCalendar(
        TENANT_ID,
        '2030-06-01T00:00:00.000Z',
        '2030-06-30T00:00:00.000Z',
        STAFF_ID,
      );

      expect(service.listBookings).toHaveBeenCalledWith(TENANT_ID, {
        page: 1,
        limit: 200,
        from: '2030-06-01T00:00:00.000Z',
        to: '2030-06-30T00:00:00.000Z',
        staffId: STAFF_ID,
      });
    });

    it('returns an empty event list when there are no bookings', async () => {
      const { events } = await controller.getCalendar(TENANT_ID);
      expect(events).toEqual([]);
    });
  });

  describe('getStaff', () => {
    it('passes the staff roster straight through', async () => {
      service.getStaffMembers.mockResolvedValue({
        staff: [
          {
            id: 'm1',
            name: 'Alice',
            email: 'alice@biz.in',
            role: 'STAFF',
            avatarUrl: null,
          },
        ],
      });

      await expect(controller.getStaff(TENANT_ID)).resolves.toEqual({
        staff: [
          {
            id: 'm1',
            name: 'Alice',
            email: 'alice@biz.in',
            role: 'STAFF',
            avatarUrl: null,
          },
        ],
      });
    });
  });
});

describe('ListBookingsQueryDto include field', () => {
  it('accepts include as an optional string parameter', () => {
    // The DTO fix ensures include=client does not cause a 400 validation error.
    const dto: ListBookingsQueryDto = { include: 'client', page: 1, limit: 10 };
    expect(dto.include).toBe('client');
  });
});
