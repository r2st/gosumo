import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  bookings,
  booking_availability,
  booking_blocked_slots,
  booking_calendar_connections,
  booking_recurrences,
} from '@prisma/client';
import { BookingStatus, ResourceNotFoundError } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreateBookingData {
  businessId: string;
  clientId: string;
  catalogItemId?: string | null;
  staffId?: string | null;
  recurrenceId?: string | null;
  status: BookingStatus;
  startAt: Date;
  endAt: Date;
  timezone: string;
  durationMinutes: number;
  locationType?: string | null;
  locationAddress?: string | null;
  meetingUrl?: string | null;
  /** Price in rupees (Decimal column). */
  price?: number | null;
  /** Deposit in rupees (Decimal column). */
  depositAmount?: number | null;
  conversationId?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BookingListFilters {
  status?: BookingStatus;
  clientId?: string;
  staffId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface PaginatedBookings {
  data: bookings[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Statuses that occupy a slot (everything except hard cancellations). */
const ACTIVE_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.RESCHEDULED,
  BookingStatus.COMPLETED,
];

/**
 * BookingRepository — all Prisma access for the Booking module.
 *
 * Every query is scoped by `business_id` and excludes soft-deleted rows.
 */
@Injectable()
export class BookingRepository {
  private readonly logger = new Logger(BookingRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────
  // Bookings
  // ─────────────────────────────────────────────

  /**
   * Create a booking atomically: inside one transaction, count overlapping
   * active bookings for the same scope and reject if capacity is exhausted,
   * then insert. This is the double-booking guard — never check then insert in
   * separate operations.
   *
   * @param capacity max concurrent active bookings allowed for this scope
   */
  async createBookingAtomic(
    data: CreateBookingData,
    capacity: number,
  ): Promise<bookings> {
    return this.prisma.$transaction(async (tx) => {
      const overlapping = await tx.bookings.count({
        where: this.overlapWhere(
          data.businessId,
          data.staffId ?? null,
          data.startAt,
          data.endAt,
        ),
      });

      if (overlapping >= capacity) {
        throw new ConflictException(
          `Slot ${data.startAt.toISOString()}–${data.endAt.toISOString()} is fully booked` +
            (data.staffId ? ` for staff ${data.staffId}` : '') +
            ` (capacity ${capacity})`,
        );
      }

      return tx.bookings.create({
        data: {
          business_id: data.businessId,
          client_id: data.clientId,
          catalog_item_id: data.catalogItemId ?? null,
          staff_id: data.staffId ?? null,
          recurrence_id: data.recurrenceId ?? null,
          status: data.status,
          start_at: data.startAt,
          end_at: data.endAt,
          timezone: data.timezone,
          duration_minutes: data.durationMinutes,
          location_type: data.locationType ?? null,
          location_address: data.locationAddress ?? null,
          meeting_url: data.meetingUrl ?? null,
          price: data.price ?? null,
          deposit_amount: data.depositAmount ?? null,
          notes: data.notes ?? null,
          metadata: {
            ...(data.metadata ?? {}),
            ...(data.conversationId ? { conversationId: data.conversationId } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * The WHERE clause matching active bookings that overlap [start, end) for a
   * scope. Overlap = existing.start < end AND existing.end > start.
   */
  private overlapWhere(
    businessId: string,
    staffId: string | null,
    start: Date,
    end: Date,
    excludeBookingId?: string,
  ): Prisma.bookingsWhereInput {
    return {
      business_id: businessId,
      staff_id: staffId,
      deleted_at: null,
      status: { in: ACTIVE_STATUSES },
      start_at: { lt: end },
      end_at: { gt: start },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    };
  }

  /**
   * Count active bookings overlapping a slot for a scope (used for slot
   * availability computation).
   */
  async countOverlapping(
    businessId: string,
    staffId: string | null,
    start: Date,
    end: Date,
    excludeBookingId?: string,
  ): Promise<number> {
    return this.prisma.bookings.count({
      where: this.overlapWhere(businessId, staffId, start, end, excludeBookingId),
    });
  }

  /** All active bookings overlapping a window — used to compute slot maps. */
  async findActiveBookingsInRange(
    businessId: string,
    staffId: string | null,
    start: Date,
    end: Date,
  ): Promise<bookings[]> {
    return this.prisma.bookings.findMany({
      where: {
        business_id: businessId,
        ...(staffId ? { staff_id: staffId } : {}),
        deleted_at: null,
        status: { in: ACTIVE_STATUSES },
        start_at: { lt: end },
        end_at: { gt: start },
      },
      orderBy: { start_at: 'asc' },
    });
  }

  async findBookingById(
    businessId: string,
    bookingId: string,
  ): Promise<bookings | null> {
    return this.prisma.bookings.findFirst({
      where: { id: bookingId, business_id: businessId, deleted_at: null },
      include: { client: true },
    });
  }

  async findBookings(
    businessId: string,
    filters: BookingListFilters,
  ): Promise<PaginatedBookings> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.bookingsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.clientId) {
      where.client_id = filters.clientId;
    }
    if (filters.staffId) {
      where.staff_id = filters.staffId;
    }
    if (filters.from || filters.to) {
      where.start_at = {};
      if (filters.from) {
        where.start_at.gte = filters.from;
      }
      if (filters.to) {
        where.start_at.lte = filters.to;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.bookings.findMany({
        where,
        orderBy: { start_at: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.bookings.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findBookingsByRecurrence(
    businessId: string,
    recurrenceId: string,
    onlyFuture?: Date,
  ): Promise<bookings[]> {
    return this.prisma.bookings.findMany({
      where: {
        business_id: businessId,
        recurrence_id: recurrenceId,
        deleted_at: null,
        ...(onlyFuture ? { start_at: { gte: onlyFuture } } : {}),
      },
      orderBy: { start_at: 'asc' },
    });
  }

  async updateBooking(
    businessId: string,
    bookingId: string,
    data: Prisma.bookingsUpdateInput,
  ): Promise<bookings> {
    const existing = await this.prisma.bookings.findFirst({
      where: { id: bookingId, business_id: businessId, deleted_at: null },
    });
    if (!existing) {
      throw new ResourceNotFoundError('Booking', bookingId, {
        context: { businessId },
      });
    }
    return this.prisma.bookings.update({
      where: { id: bookingId, business_id: businessId },
      data,
      include: { client: true },
    });
  }

  /**
   * CAS status transition: only writes if the current status matches
   * `expectedStatus`. Returns `null` when the row has already moved.
   */
  async transitionStatus(
    businessId: string,
    bookingId: string,
    expectedStatus: BookingStatus,
    data: Prisma.bookingsUpdateInput,
  ): Promise<bookings | null> {
    const { count } = await this.prisma.bookings.updateMany({
      where: {
        id: bookingId,
        business_id: businessId,
        status: expectedStatus,
        deleted_at: null,
      },
      data,
    });
    if (count === 0) return null;
    return this.prisma.bookings.findFirst({
      where: { id: bookingId, business_id: businessId },
      include: { client: true },
    });
  }

  /**
   * Find the bookings owned by a payment id (used by the payment.success
   * listener to auto-confirm).
   */
  async findByPaymentId(
    businessId: string,
    paymentId: string,
  ): Promise<bookings | null> {
    return this.prisma.bookings.findFirst({
      where: { business_id: businessId, payment_id: paymentId, deleted_at: null },
    });
  }

  // ─────────────────────────────────────────────
  // Availability
  // ─────────────────────────────────────────────

  /**
   * Resolve the availability template for a scope. Falls back to the
   * business-wide default (staff_id null) when no per-staff template exists.
   */
  async findAvailability(
    businessId: string,
    staffId: string | null,
  ): Promise<booking_availability | null> {
    if (staffId) {
      const staffRule = await this.prisma.booking_availability.findFirst({
        where: { business_id: businessId, staff_id: staffId, deleted_at: null },
      });
      if (staffRule) {
        return staffRule;
      }
    }
    return this.prisma.booking_availability.findFirst({
      where: { business_id: businessId, staff_id: null, deleted_at: null },
    });
  }

  async upsertAvailability(
    businessId: string,
    staffId: string | null,
    data: {
      timezone: string;
      weeklyHours: Prisma.InputJsonValue;
      slotIntervalMinutes: number;
      bufferMinutes: number;
      minNoticeMinutes: number;
      maxAdvanceDays: number;
      capacityPerSlot: number;
    },
  ): Promise<booking_availability> {
    const existing = await this.prisma.booking_availability.findFirst({
      where: { business_id: businessId, staff_id: staffId, deleted_at: null },
    });

    const payload = {
      timezone: data.timezone,
      weekly_hours: data.weeklyHours,
      slot_interval_minutes: data.slotIntervalMinutes,
      buffer_minutes: data.bufferMinutes,
      min_notice_minutes: data.minNoticeMinutes,
      max_advance_days: data.maxAdvanceDays,
      capacity_per_slot: data.capacityPerSlot,
      is_active: true,
    };

    if (existing) {
      return this.prisma.booking_availability.update({
        where: { id: existing.id, business_id: businessId },
        data: payload,
      });
    }
    return this.prisma.booking_availability.create({
      data: { business_id: businessId, staff_id: staffId, ...payload },
    });
  }

  async listAvailability(businessId: string): Promise<booking_availability[]> {
    return this.prisma.booking_availability.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { created_at: 'asc' },
    });
  }

  // ─────────────────────────────────────────────
  // Blocked slots
  // ─────────────────────────────────────────────

  async createBlock(
    businessId: string,
    data: { staffId: string | null; startAt: Date; endAt: Date; reason?: string },
  ): Promise<booking_blocked_slots> {
    return this.prisma.booking_blocked_slots.create({
      data: {
        business_id: businessId,
        staff_id: data.staffId,
        start_at: data.startAt,
        end_at: data.endAt,
        reason: data.reason ?? null,
      },
    });
  }

  async deleteBlock(businessId: string, blockId: string): Promise<void> {
    const existing = await this.prisma.booking_blocked_slots.findFirst({
      where: { id: blockId, business_id: businessId, deleted_at: null },
    });
    if (!existing) {
      throw new ResourceNotFoundError('Blocked slot', blockId, {
        context: { businessId },
      });
    }
    await this.prisma.booking_blocked_slots.update({
      where: { id: blockId, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  /** Blocks overlapping a window for the scope (staff-specific + business-wide). */
  async findBlocksInRange(
    businessId: string,
    staffId: string | null,
    start: Date,
    end: Date,
  ): Promise<booking_blocked_slots[]> {
    return this.prisma.booking_blocked_slots.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        start_at: { lt: end },
        end_at: { gt: start },
        // A business-wide block (staff_id null) applies to everyone; a
        // staff-specific block only applies when querying that staff.
        OR: [{ staff_id: null }, ...(staffId ? [{ staff_id: staffId }] : [])],
      },
      orderBy: { start_at: 'asc' },
    });
  }

  // ─────────────────────────────────────────────
  // Calendar connections
  // ─────────────────────────────────────────────

  async findConnection(
    businessId: string,
    staffId: string | null,
    provider = 'google',
  ): Promise<booking_calendar_connections | null> {
    return this.prisma.booking_calendar_connections.findFirst({
      where: {
        business_id: businessId,
        staff_id: staffId,
        provider,
        deleted_at: null,
      },
    });
  }

  async upsertConnection(
    businessId: string,
    staffId: string | null,
    data: {
      provider: string;
      googleCalendarId: string | null;
      googleAccountEmail?: string | null;
      accessToken: string | null;
      refreshToken: string | null;
      tokenExpiresAt: Date | null;
      scope: string | null;
    },
  ): Promise<booking_calendar_connections> {
    const existing = await this.findConnection(businessId, staffId, data.provider);
    const payload = {
      google_calendar_id: data.googleCalendarId,
      google_account_email: data.googleAccountEmail ?? null,
      access_token: data.accessToken,
      refresh_token: data.refreshToken,
      token_expires_at: data.tokenExpiresAt,
      scope: data.scope,
      sync_enabled: true,
      last_sync_error: null,
    };
    if (existing) {
      return this.prisma.booking_calendar_connections.update({
        where: { id: existing.id, business_id: businessId },
        data: payload,
      });
    }
    return this.prisma.booking_calendar_connections.create({
      data: {
        business_id: businessId,
        staff_id: staffId,
        provider: data.provider,
        ...payload,
      },
    });
  }

  async updateConnection(
    businessId: string,
    connectionId: string,
    data: Prisma.booking_calendar_connectionsUpdateInput,
  ): Promise<booking_calendar_connections> {
    return this.prisma.booking_calendar_connections.update({
      where: { id: connectionId, business_id: businessId },
      data,
    });
  }

  async deleteConnection(businessId: string, connectionId: string): Promise<void> {
    await this.prisma.booking_calendar_connections.update({
      where: { id: connectionId, business_id: businessId },
      data: { deleted_at: new Date(), sync_enabled: false },
    });
  }

  // ─────────────────────────────────────────────
  // Recurrences
  // ─────────────────────────────────────────────

  async createRecurrence(data: {
    businessId: string;
    clientId: string;
    catalogItemId?: string | null;
    staffId?: string | null;
    rule: Prisma.InputJsonValue;
    startAt: Date;
    durationMinutes: number;
    timezone: string;
    locationType?: string | null;
    locationAddress?: string | null;
    meetingUrl?: string | null;
    price?: number | null;
    notes?: string | null;
  }): Promise<booking_recurrences> {
    return this.prisma.booking_recurrences.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        catalog_item_id: data.catalogItemId ?? null,
        staff_id: data.staffId ?? null,
        rule: data.rule,
        start_at: data.startAt,
        duration_minutes: data.durationMinutes,
        timezone: data.timezone,
        location_type: data.locationType ?? null,
        location_address: data.locationAddress ?? null,
        meeting_url: data.meetingUrl ?? null,
        price: data.price ?? null,
        notes: data.notes ?? null,
      },
    });
  }

  async findRecurrence(
    businessId: string,
    recurrenceId: string,
  ): Promise<booking_recurrences | null> {
    return this.prisma.booking_recurrences.findFirst({
      where: { id: recurrenceId, business_id: businessId, deleted_at: null },
    });
  }

  async deactivateRecurrence(
    businessId: string,
    recurrenceId: string,
  ): Promise<void> {
    await this.prisma.booking_recurrences.updateMany({
      where: { id: recurrenceId, business_id: businessId },
      data: { is_active: false },
    });
  }
}
