import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import type { bookings, booking_calendar_connections } from '@prisma/client';
import {
  BookingStatus,
  BookingActor,
  TaskType,
  TaskPriority,
  generateId,
  generateCorrelationId,
  currencyToPaise,
} from '@gosumo/shared';
import type {
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingCancelledEvent,
  BookingRescheduledEvent,
  BookingCompletedEvent,
  BookingReminderEvent,
  TaskCreatedEvent,
  PaymentSuccessEvent,
} from '@gosumo/shared';
import { ConfigurationError } from '@gosumo/shared';
import { BookingRepository } from './booking.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { GoogleCalendarService } from './google-calendar.service';
import { TenantService } from '../tenant/tenant.service';
import {
  IST_TIMEZONE,
  utcToZonedParts,
  localDaySlotToUtc,
  addDaysToParts,
  ZonedParts,
} from './timezone.util';
import {
  expandRecurrence,
  validateRecurrenceRule,
  RecurrenceRule,
} from './recurrence.util';
import {
  BOOKING_QUEUE,
  BOOKING_JOBS,
  DEFAULT_REMINDER_OFFSETS_MINUTES,
  AUTO_CANCEL_PENDING_HOURS,
  STAFF_ROSTER_LIMIT,
  ReminderJobData,
  AutoCancelJobData,
} from './booking.constants';
import {
  CreateBookingDto,
  CreateRecurringBookingDto,
  RescheduleBookingDto,
  CancelBookingDto,
  GetSlotsQueryDto,
  SetAvailabilityDto,
  BlockSlotDto,
  ConnectGoogleCalendarDto,
  ListBookingsQueryDto,
  BookingDto,
  SlotDto,
  AvailabilityDto,
  BlockedSlotDto,
  CalendarConnectionDto,
  WeeklyHourDto,
  RecurringBookingResultDto,
  StaffMemberDto,
} from './dto';

interface WeeklyHour {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

/** Max days a single getAvailableSlots query may span. */
const MAX_SLOT_RANGE_DAYS = 62;

// ─────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────

function toBookingDto(b: bookings): BookingDto {
  return {
    id: b.id,
    businessId: b.business_id,
    clientId: b.client_id,
    catalogItemId: b.catalog_item_id,
    staffId: b.staff_id,
    recurrenceId: b.recurrence_id,
    status: b.status as BookingStatus,
    startAt: b.start_at.toISOString(),
    endAt: b.end_at.toISOString(),
    timezone: b.timezone,
    durationMinutes: b.duration_minutes,
    locationType: b.location_type,
    locationAddress: b.location_address,
    meetingUrl: b.meeting_url,
    pricePaise: b.price != null ? currencyToPaise(Number(b.price)) : null,
    depositPaise:
      b.deposit_amount != null ? currencyToPaise(Number(b.deposit_amount)) : null,
    paymentId: b.payment_id,
    gcalEventId: b.gcal_event_id,
    gcalCalendarId: b.gcal_calendar_id,
    remindersSent: b.reminders_sent,
    lastReminderAt: b.last_reminder_at?.toISOString() ?? null,
    cancelledAt: b.cancelled_at?.toISOString() ?? null,
    cancellationReason: b.cancellation_reason,
    cancelledBy: b.cancelled_by,
    notes: b.notes,
    createdAt: b.created_at.toISOString(),
    updatedAt: b.updated_at.toISOString(),
  };
}

/**
 * BookingService — appointment lifecycle, availability/slot computation,
 * recurring series, reminders, and Google Calendar sync.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly repository: BookingRepository,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly googleCalendar: GoogleCalendarService,
    private readonly tenantService: TenantService,
    @InjectQueue(BOOKING_QUEUE) private readonly queue: Queue,
  ) {}

  // ════════════════════════════════════════════
  // Booking creation
  // ════════════════════════════════════════════

  /**
   * Create a single appointment.
   *
   * Validates the slot (not in the past, not inside a block), then inserts
   * inside a transaction that re-checks capacity to prevent double-booking.
   * PENDING bookings get a 24h auto-cancel job; confirmed bookings get reminder
   * jobs and are pushed to Google Calendar (best-effort).
   */
  /**
   * Reject a `staffId` that is not this tenant's team member.
   *
   * `@TenantId()` scopes the row being written, but `staffId` arrives in the
   * request body as a second, unscoped reference. `bookings.staff_id` is
   * satisfied by any real member row, and the availability, block and calendar
   * tables key on it without a tenant join — so without this a business can
   * pin its own rows to another business's staff member. Omitting `staffId`
   * (business-wide, no specific staff) is always valid.
   */
  private async assertStaffMember(
    businessId: string,
    staffId?: string | null,
  ): Promise<void> {
    if (!staffId) return;
    await this.tenantService.assertTeamMember(businessId, staffId);
  }

  async createBooking(
    businessId: string,
    dto: CreateBookingDto,
  ): Promise<BookingDto> {
    await this.assertStaffMember(businessId, dto.staffId);

    const startAt = this.parseInstant(dto.startAt, 'startAt');
    const endAt = new Date(startAt.getTime() + dto.durationMinutes * 60_000);
    const timezone = dto.timezone ?? IST_TIMEZONE;

    await this.assertSlotBookable(businessId, dto.staffId ?? null, startAt, endAt);

    const capacity = await this.resolveCapacity(businessId, dto.staffId ?? null);
    const status = dto.autoConfirm ? BookingStatus.CONFIRMED : BookingStatus.PENDING;

    const booking = await this.repository.createBookingAtomic(
      {
        businessId,
        clientId: dto.clientId,
        catalogItemId: dto.catalogItemId ?? null,
        staffId: dto.staffId ?? null,
        status,
        startAt,
        endAt,
        timezone,
        durationMinutes: dto.durationMinutes,
        locationType: dto.locationType ?? null,
        locationAddress: dto.locationAddress ?? null,
        meetingUrl: dto.meetingUrl ?? null,
        price: dto.pricePaise != null ? dto.pricePaise / 100 : null,
        depositAmount: dto.depositPaise != null ? dto.depositPaise / 100 : null,
        conversationId: dto.conversationId ?? null,
        notes: dto.notes ?? null,
      },
      capacity,
    );

    await this.afterBookingCreated(businessId, booking);
    return toBookingDto(booking);
  }

  /**
   * Create a recurring series: persist the rule, expand it into occurrences,
   * and create each occurrence as its own booking. Occurrences whose slot is
   * already taken are skipped (reported back), never silently dropped.
   */
  async createRecurringBooking(
    businessId: string,
    dto: CreateRecurringBookingDto,
  ): Promise<RecurringBookingResultDto> {
    await this.assertStaffMember(businessId, dto.staffId);

    const startAt = this.parseInstant(dto.startAt, 'startAt');
    const timezone = dto.timezone ?? IST_TIMEZONE;

    const rule: RecurrenceRule = {
      frequency: dto.recurrence.frequency,
      interval: dto.recurrence.interval,
      count: dto.recurrence.count,
      until: dto.recurrence.until,
      byWeekday: dto.recurrence.byWeekday,
    };

    validateRecurrenceRule(rule);

    const occurrences = expandRecurrence(
      rule,
      startAt,
      dto.durationMinutes,
      timezone,
    );

    if (occurrences.length === 0) {
      throw new BadRequestException('Recurrence produced no occurrences');
    }

    const recurrence = await this.repository.createRecurrence({
      businessId,
      clientId: dto.clientId,
      catalogItemId: dto.catalogItemId ?? null,
      staffId: dto.staffId ?? null,
      rule: rule as unknown as Prisma.InputJsonValue,
      startAt,
      durationMinutes: dto.durationMinutes,
      timezone,
      locationType: dto.locationType ?? null,
      locationAddress: dto.locationAddress ?? null,
      meetingUrl: dto.meetingUrl ?? null,
      price: dto.pricePaise != null ? dto.pricePaise / 100 : null,
      notes: dto.notes ?? null,
    });

    const capacity = await this.resolveCapacity(businessId, dto.staffId ?? null);
    const status = dto.autoConfirm ? BookingStatus.CONFIRMED : BookingStatus.PENDING;
    const created: BookingDto[] = [];
    const skipped: Array<{ startAt: string; reason: string }> = [];

    // Blocked slots for the whole series, fetched once. A weekly rule over a
    // year expands to ~52 occurrences, and asking per occurrence meant that
    // many sequential round trips before the first booking row was written.
    // The rows are the same set either way — the per-occurrence predicate is
    // an interval overlap, which is cheaper to apply in memory than to re-ask.
    const seriesBlocks = await this.repository.findBlocksInRange(
      businessId,
      dto.staffId ?? null,
      new Date(Math.min(...occurrences.map((o) => o.startAt.getTime()))),
      new Date(Math.max(...occurrences.map((o) => o.endAt.getTime()))),
    );

    for (const occ of occurrences) {
      // Skip occurrences in the past, but keep generating future ones.
      if (occ.startAt.getTime() <= Date.now()) {
        skipped.push({ startAt: occ.startAt.toISOString(), reason: 'in the past' });
        continue;
      }
      try {
        // Same overlap test the repository applies: starts before this
        // occurrence ends, and ends after it starts.
        const blocked = seriesBlocks.filter(
          (b) =>
            b.start_at.getTime() < occ.endAt.getTime() &&
            b.end_at.getTime() > occ.startAt.getTime(),
        );
        if (blocked.length > 0) {
          skipped.push({
            startAt: occ.startAt.toISOString(),
            reason: 'blocked time',
          });
          continue;
        }

        const booking = await this.repository.createBookingAtomic(
          {
            businessId,
            clientId: dto.clientId,
            catalogItemId: dto.catalogItemId ?? null,
            staffId: dto.staffId ?? null,
            recurrenceId: recurrence.id,
            status,
            startAt: occ.startAt,
            endAt: occ.endAt,
            timezone,
            durationMinutes: dto.durationMinutes,
            locationType: dto.locationType ?? null,
            locationAddress: dto.locationAddress ?? null,
            meetingUrl: dto.meetingUrl ?? null,
            price: dto.pricePaise != null ? dto.pricePaise / 100 : null,
            depositAmount: dto.depositPaise != null ? dto.depositPaise / 100 : null,
            notes: dto.notes ?? null,
          },
          capacity,
        );
        await this.afterBookingCreated(businessId, booking);
        created.push(toBookingDto(booking));
      } catch (err) {
        skipped.push({
          startAt: occ.startAt.toISOString(),
          reason: err instanceof Error ? err.message : 'slot unavailable',
        });
      }
    }

    this.logger.log(
      `Recurring series ${recurrence.id}: ${created.length} created, ${skipped.length} skipped`,
    );

    return { recurrenceId: recurrence.id, occurrences: created, skipped };
  }

  /** Post-creation side effects shared by single and recurring bookings. */
  private async afterBookingCreated(
    businessId: string,
    booking: bookings,
  ): Promise<void> {
    const event: BookingCreatedEvent = {
      type: 'booking.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: booking.id,
      clientId: booking.client_id,
      catalogItemId: booking.catalog_item_id ?? undefined,
      staffMemberId: booking.staff_id ?? undefined,
      startAt: booking.start_at.toISOString(),
      endAt: booking.end_at.toISOString(),
      status: booking.status as BookingStatus,
    };
    this.eventEmitter.emit('booking.created', event);

    if (booking.status === BookingStatus.PENDING) {
      await this.scheduleAutoCancel(businessId, booking.id);
    } else if (booking.status === BookingStatus.CONFIRMED) {
      await this.scheduleReminders(businessId, booking.id);
      await this.pushBookingToCalendar(businessId, booking);
    }

    this.logger.log(
      `Booking ${booking.id} created (${booking.status}) ` +
        `start=${booking.start_at.toISOString()} staff=${booking.staff_id ?? 'any'}`,
    );
  }

  // ════════════════════════════════════════════
  // Retrieval
  // ════════════════════════════════════════════

  async getBooking(businessId: string, bookingId: string): Promise<BookingDto> {
    const booking = await this.repository.findBookingById(businessId, bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return toBookingDto(booking);
  }

  async listBookings(
    businessId: string,
    query: ListBookingsQueryDto,
  ): Promise<{
    data: BookingDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const result = await this.repository.findBookings(businessId, {
      status: query.status,
      clientId: query.clientId,
      staffId: query.staffId,
      from: query.from ? this.parseInstant(query.from, 'from') : undefined,
      to: query.to ? this.parseInstant(query.to, 'to') : undefined,
      page: query.page,
      limit: query.limit,
    });
    return {
      data: result.data.map(toBookingDto),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  // ════════════════════════════════════════════
  // Lifecycle transitions
  // ════════════════════════════════════════════

  /** PENDING → CONFIRMED. Schedules reminders and syncs to calendar. */
  async confirmBooking(
    businessId: string,
    bookingId: string,
  ): Promise<BookingDto> {
    const booking = await this.requireBooking(businessId, bookingId);
    const current = booking.status as BookingStatus;

    if (current === BookingStatus.CONFIRMED) {
      return toBookingDto(booking);
    }
    if (current !== BookingStatus.PENDING) {
      throw new BadRequestException(
        `Cannot confirm a booking in status ${current}`,
      );
    }

    const updated = await this.repository.transitionStatus(
      businessId, bookingId, BookingStatus.PENDING,
      { status: BookingStatus.CONFIRMED },
    );
    if (!updated) {
      this.logger.debug(`Booking ${bookingId} changed status concurrently — confirm skipped`);
      return toBookingDto(booking);
    }

    const event: BookingConfirmedEvent = {
      type: 'booking.confirmed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: updated.id,
      clientId: updated.client_id,
      catalogItemId: updated.catalog_item_id ?? undefined,
      staffMemberId: updated.staff_id ?? undefined,
      startAt: updated.start_at.toISOString(),
      endAt: updated.end_at.toISOString(),
    };
    this.eventEmitter.emit('booking.confirmed', event);

    await this.scheduleReminders(businessId, updated.id);
    await this.pushBookingToCalendar(businessId, updated);

    this.logger.log(`Booking ${bookingId} confirmed`);
    return toBookingDto(updated);
  }

  /**
   * Cancel a booking (or the whole series). Frees the slot, removes the Google
   * Calendar event, and emits `booking.cancelled`.
   */
  async cancelBooking(
    businessId: string,
    bookingId: string,
    dto: CancelBookingDto,
  ): Promise<BookingDto> {
    const booking = await this.requireBooking(businessId, bookingId);
    const current = booking.status as BookingStatus;

    if (current === BookingStatus.CANCELLED) {
      throw new BadRequestException('Booking is already cancelled');
    }
    if (current === BookingStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed booking');
    }

    const cancelledBy = dto.cancelledBy ?? BookingActor.BUSINESS;

    if (dto.cancelSeries && booking.recurrence_id) {
      await this.cancelSeries(businessId, booking.recurrence_id, dto.reason, cancelledBy);
    }

    const updated = await this.applyCancellation(
      businessId,
      booking,
      dto.reason,
      cancelledBy,
    );

    return toBookingDto(updated);
  }

  private async cancelSeries(
    businessId: string,
    recurrenceId: string,
    reason: string,
    cancelledBy: BookingActor,
  ): Promise<void> {
    await this.repository.deactivateRecurrence(businessId, recurrenceId);
    const future = await this.repository.findBookingsByRecurrence(
      businessId,
      recurrenceId,
      new Date(),
    );
    for (const sibling of future) {
      const status = sibling.status as BookingStatus;
      if (status === BookingStatus.CANCELLED || status === BookingStatus.COMPLETED) {
        continue;
      }
      await this.applyCancellation(businessId, sibling, reason, cancelledBy);
    }
    this.logger.log(
      `Cancelled recurring series ${recurrenceId} (${future.length} future occurrences)`,
    );
  }

  private async applyCancellation(
    businessId: string,
    booking: bookings,
    reason: string,
    cancelledBy: BookingActor,
  ): Promise<bookings> {
    const updated = await this.repository.updateBooking(businessId, booking.id, {
      status: BookingStatus.CANCELLED,
      cancelled_at: new Date(),
      cancellation_reason: reason,
      cancelled_by: cancelledBy,
    });

    await this.removeBookingFromCalendar(businessId, updated);

    const event: BookingCancelledEvent = {
      type: 'booking.cancelled',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: updated.id,
      clientId: updated.client_id,
      cancelledBy,
      reason,
    };
    this.eventEmitter.emit('booking.cancelled', event);

    this.logger.log(`Booking ${booking.id} cancelled by ${cancelledBy}: ${reason}`);
    return updated;
  }

  /**
   * Move a booking to a new time (and optionally new staff). Re-checks
   * availability/capacity at the new slot, updates the calendar event, and
   * re-schedules reminders.
   */
  async rescheduleBooking(
    businessId: string,
    bookingId: string,
    dto: RescheduleBookingDto,
  ): Promise<BookingDto> {
    await this.assertStaffMember(businessId, dto.staffId);

    const booking = await this.requireBooking(businessId, bookingId);
    const current = booking.status as BookingStatus;

    if (current === BookingStatus.CANCELLED || current === BookingStatus.COMPLETED) {
      throw new BadRequestException(
        `Cannot reschedule a booking in status ${current}`,
      );
    }

    const newStart = this.parseInstant(dto.newStartAt, 'newStartAt');
    const duration = dto.durationMinutes ?? booking.duration_minutes;
    const newEnd = new Date(newStart.getTime() + duration * 60_000);
    const newStaffId = dto.staffId ?? booking.staff_id ?? null;

    await this.assertSlotBookable(
      businessId,
      newStaffId,
      newStart,
      newEnd,
      bookingId,
    );

    const oldStart = booking.start_at;
    const oldEnd = booking.end_at;

    const updated = await this.repository.updateBooking(businessId, bookingId, {
      status: BookingStatus.RESCHEDULED,
      start_at: newStart,
      end_at: newEnd,
      duration_minutes: duration,
      staff_id: newStaffId,
    });

    await this.pushBookingToCalendar(businessId, updated);
    await this.scheduleReminders(businessId, updated.id);

    const event: BookingRescheduledEvent = {
      type: 'booking.rescheduled',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: updated.id,
      clientId: updated.client_id,
      staffMemberId: updated.staff_id ?? undefined,
      oldStartAt: oldStart.toISOString(),
      oldEndAt: oldEnd.toISOString(),
      newStartAt: newStart.toISOString(),
      newEndAt: newEnd.toISOString(),
      rescheduledBy: dto.rescheduledBy ?? BookingActor.BUSINESS,
    };
    this.eventEmitter.emit('booking.rescheduled', event);

    this.logger.log(
      `Booking ${bookingId} rescheduled ${oldStart.toISOString()} → ${newStart.toISOString()}`,
    );
    return toBookingDto(updated);
  }

  /** Mark a booking COMPLETED (after the appointment happened). */
  async completeBooking(
    businessId: string,
    bookingId: string,
  ): Promise<BookingDto> {
    const booking = await this.requireBooking(businessId, bookingId);
    const current = booking.status as BookingStatus;
    if (current === BookingStatus.CANCELLED) {
      throw new BadRequestException('Cannot complete a cancelled booking');
    }

    const updated = await this.repository.updateBooking(businessId, bookingId, {
      status: BookingStatus.COMPLETED,
    });

    const event: BookingCompletedEvent = {
      type: 'booking.completed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: updated.id,
      clientId: updated.client_id,
      catalogItemId: updated.catalog_item_id ?? undefined,
      staffMemberId: updated.staff_id ?? undefined,
    };
    this.eventEmitter.emit('booking.completed', event);
    this.logger.log(`Booking ${bookingId} marked COMPLETED`);
    return toBookingDto(updated);
  }

  /** Mark a booking NO_SHOW. */
  async markNoShow(businessId: string, bookingId: string): Promise<BookingDto> {
    const booking = await this.requireBooking(businessId, bookingId);
    const current = booking.status as BookingStatus;
    if (current === BookingStatus.CANCELLED || current === BookingStatus.COMPLETED) {
      throw new BadRequestException(
        `Cannot mark a ${current} booking as no-show`,
      );
    }
    const updated = await this.repository.updateBooking(businessId, bookingId, {
      status: BookingStatus.NO_SHOW,
    });
    this.logger.log(`Booking ${bookingId} marked NO_SHOW`);
    return toBookingDto(updated);
  }

  // ════════════════════════════════════════════
  // Availability & slots
  // ════════════════════════════════════════════

  /** Create/replace the weekly availability template for a business or staff. */
  async setAvailability(
    businessId: string,
    dto: SetAvailabilityDto,
  ): Promise<AvailabilityDto> {
    await this.assertStaffMember(businessId, dto.staffId);

    for (const w of dto.weeklyHours) {
      if (w.endMinute <= w.startMinute) {
        throw new BadRequestException(
          `Invalid window for day ${w.dayOfWeek}: endMinute must be after startMinute`,
        );
      }
    }

    const row = await this.repository.upsertAvailability(
      businessId,
      dto.staffId ?? null,
      {
        timezone: dto.timezone ?? IST_TIMEZONE,
        weeklyHours: dto.weeklyHours as unknown as Prisma.InputJsonValue,
        slotIntervalMinutes: dto.slotIntervalMinutes ?? 30,
        bufferMinutes: dto.bufferMinutes ?? 0,
        minNoticeMinutes: dto.minNoticeMinutes ?? 120,
        maxAdvanceDays: dto.maxAdvanceDays ?? 60,
        capacityPerSlot: dto.capacityPerSlot ?? 1,
      },
    );

    return {
      id: row.id,
      businessId: row.business_id,
      staffId: row.staff_id,
      timezone: row.timezone,
      weeklyHours: row.weekly_hours as unknown as WeeklyHourDto[],
      slotIntervalMinutes: row.slot_interval_minutes,
      bufferMinutes: row.buffer_minutes,
      minNoticeMinutes: row.min_notice_minutes,
      maxAdvanceDays: row.max_advance_days,
      capacityPerSlot: row.capacity_per_slot,
      isActive: row.is_active,
    };
  }

  /**
   * Compute bookable slots over a date range.
   *
   * Slots are derived dynamically: weekly windows → candidate starts at
   * `slotInterval` granularity → filtered by min-notice, max-advance, blocks,
   * and existing bookings (capacity). No slot rows are stored.
   */
  async getAvailableSlots(
    businessId: string,
    query: GetSlotsQueryDto,
  ): Promise<SlotDto[]> {
    const rangeStart = this.parseInstant(query.from, 'from');
    const rangeEnd = this.parseInstant(query.to, 'to');

    if (rangeEnd <= rangeStart) {
      throw new BadRequestException('`to` must be after `from`');
    }
    const spanDays = (rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000;
    if (spanDays > MAX_SLOT_RANGE_DAYS) {
      throw new BadRequestException(
        `Slot query range cannot exceed ${MAX_SLOT_RANGE_DAYS} days`,
      );
    }

    const staffId = query.staffId ?? null;
    const availability = await this.repository.findAvailability(businessId, staffId);
    if (!availability) {
      this.logger.debug(
        `No availability template for business ${businessId} (staff ${staffId ?? 'any'})`,
      );
      return [];
    }

    const timezone = availability.timezone;
    const weeklyHours = (availability.weekly_hours as unknown as WeeklyHour[]) ?? [];
    if (weeklyHours.length === 0) {
      return [];
    }

    const duration = query.durationMinutes;
    const buffer = availability.buffer_minutes;
    const interval = availability.slot_interval_minutes;
    const capacity = staffId ? 1 : availability.capacity_per_slot;

    const now = Date.now();
    const earliestStart = now + availability.min_notice_minutes * 60_000;
    const latestStart = now + availability.max_advance_days * 86_400_000;

    // Pre-load existing bookings and blocks across the whole range once.
    const [existing, blocks] = await Promise.all([
      this.repository.findActiveBookingsInRange(businessId, staffId, rangeStart, rangeEnd),
      this.repository.findBlocksInRange(businessId, staffId, rangeStart, rangeEnd),
    ]);

    const slots: SlotDto[] = [];

    // Iterate calendar days in the business timezone. Start one day early to
    // catch windows that begin late on the prior local day.
    let dayAnchor: ZonedParts = utcToZonedParts(
      new Date(rangeStart.getTime() - 86_400_000),
      timezone,
    );
    dayAnchor = { ...dayAnchor, hour: 0, minute: 0, second: 0 };

    for (let d = 0; d <= spanDays + 2; d++) {
      const anchor = addDaysToParts(dayAnchor, d);
      const windows = weeklyHours.filter((w) => w.dayOfWeek === anchor.weekday);

      for (const window of windows) {
        for (
          let m = window.startMinute;
          m + duration <= window.endMinute;
          m += interval
        ) {
          const slotStart = localDaySlotToUtc(anchor, m, timezone);
          const slotEnd = new Date(slotStart.getTime() + duration * 60_000);

          // Range and policy filters.
          if (slotStart < rangeStart || slotStart >= rangeEnd) continue;
          if (slotStart.getTime() < earliestStart) continue;
          if (slotStart.getTime() > latestStart) continue;

          // Blocked?
          if (
            blocks.some(
              (b) => b.start_at < slotEnd && b.end_at > slotStart,
            )
          ) {
            continue;
          }

          // Capacity: count overlapping active bookings, honouring buffer.
          const bufferedStart = new Date(slotStart.getTime() - buffer * 60_000);
          const bufferedEnd = new Date(slotEnd.getTime() + buffer * 60_000);
          const taken = existing.filter(
            (b) => b.start_at < bufferedEnd && b.end_at > bufferedStart,
          ).length;

          const available = capacity - taken;
          if (available <= 0) continue;

          slots.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            available,
            staffId,
          });
        }
      }
    }

    // De-dupe (a window may appear twice from the day-overlap iteration) and sort.
    const seen = new Set<string>();
    const unique = slots.filter((s) => {
      if (seen.has(s.startAt)) return false;
      seen.add(s.startAt);
      return true;
    });
    unique.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return unique;
  }

  // ════════════════════════════════════════════
  // Blocked slots
  // ════════════════════════════════════════════

  async blockSlot(businessId: string, dto: BlockSlotDto): Promise<BlockedSlotDto> {
    await this.assertStaffMember(businessId, dto.staffId);

    const startAt = this.parseInstant(dto.startAt, 'startAt');
    const endAt = this.parseInstant(dto.endAt, 'endAt');
    if (endAt <= startAt) {
      throw new BadRequestException('Block endAt must be after startAt');
    }
    const row = await this.repository.createBlock(businessId, {
      staffId: dto.staffId ?? null,
      startAt,
      endAt,
      reason: dto.reason,
    });
    this.logger.log(
      `Blocked ${startAt.toISOString()}–${endAt.toISOString()} for ${dto.staffId ?? 'whole business'}`,
    );
    return {
      id: row.id,
      businessId: row.business_id,
      staffId: row.staff_id,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at.toISOString(),
      reason: row.reason,
    };
  }

  async unblockSlot(businessId: string, blockId: string): Promise<void> {
    await this.repository.deleteBlock(businessId, blockId);
    this.logger.log(`Unblocked slot ${blockId}`);
  }

  // ════════════════════════════════════════════
  // Google Calendar
  // ════════════════════════════════════════════

  /** Build the Google consent URL; `state` encodes the tenant (+ optional staff). */
  getGoogleAuthUrl(
    businessId: string,
    staffId?: string,
    redirectUri?: string,
  ): { url: string } {
    const state = staffId ? `${businessId}:${staffId}` : businessId;
    return { url: this.googleCalendar.getAuthUrl(state, redirectUri) };
  }

  /** Exchange the OAuth code and persist the calendar connection. */
  async connectGoogleCalendar(
    businessId: string,
    dto: ConnectGoogleCalendarDto,
  ): Promise<CalendarConnectionDto> {
    // Checked before the code exchange: a rejected staffId must not burn the
    // single-use OAuth authorization code.
    await this.assertStaffMember(businessId, dto.staffId);

    const tokens = await this.googleCalendar.exchangeCode(dto.authCode, dto.redirectUri);

    if (!tokens.refreshToken) {
      this.logger.warn(
        `Google connection for ${businessId} returned no refresh token — ` +
          'sync will stop when the access token expires. Re-consent with prompt=consent.',
      );
    }

    const connection = await this.repository.upsertConnection(
      businessId,
      dto.staffId ?? null,
      {
        provider: 'google',
        googleCalendarId: dto.calendarId ?? 'primary',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        scope: tokens.scope,
      },
    );

    this.logger.log(`Google Calendar connected for business ${businessId}`);
    return this.toConnectionDto(connection);
  }

  async disconnectGoogleCalendar(
    businessId: string,
    staffId?: string,
  ): Promise<void> {
    const connection = await this.repository.findConnection(
      businessId,
      staffId ?? null,
    );
    if (!connection) {
      throw new NotFoundException('No Google Calendar connection found');
    }
    await this.repository.deleteConnection(businessId, connection.id);
    this.logger.log(`Google Calendar disconnected for business ${businessId}`);
  }

  /**
   * Push all future active bookings to Google Calendar. Refreshes the token
   * silently; if the refresh fails, raises a HITL task and records the error.
   */
  async syncGoogleCalendar(
    businessId: string,
    staffId?: string,
  ): Promise<{ synced: number; failed: number }> {
    const connection = await this.repository.findConnection(
      businessId,
      staffId ?? null,
    );
    if (!connection || !connection.sync_enabled) {
      throw new BadRequestException('No active Google Calendar connection');
    }

    let accessToken: string;
    try {
      accessToken = await this.ensureAccessToken(connection);
    } catch (err) {
      await this.handleCalendarAuthFailure(businessId, connection, err);
      throw new BadRequestException(
        'Google Calendar token refresh failed — re-authentication required',
      );
    }

    const future = await this.repository.findBookings(businessId, {
      from: new Date(),
      limit: 100,
    });

    let synced = 0;
    let failed = 0;
    for (const booking of future.data) {
      const status = booking.status as BookingStatus;
      if (status === BookingStatus.CANCELLED || status === BookingStatus.NO_SHOW) {
        continue;
      }
      if (staffId && booking.staff_id !== staffId) {
        continue;
      }
      try {
        await this.upsertCalendarEvent(booking, connection, accessToken);
        synced++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `Calendar sync failed for booking ${booking.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.repository.updateConnection(businessId, connection.id, {
      last_synced_at: new Date(),
      last_sync_error: null,
    });

    this.logger.log(
      `Google Calendar sync for ${businessId}: ${synced} synced, ${failed} failed`,
    );
    return { synced, failed };
  }

  /**
   * Push an arbitrary realty site-visit event to the connected Google Calendar.
   * Reuses the booking module's OAuth connection + silent token refresh so the
   * `realty-sitevisits` module never touches calendar credentials directly.
   *
   * Best-effort: returns `null` when there is no active connection or the token
   * refresh fails (a HITL task is raised in that case) — the caller still keeps
   * the visit; it just isn't mirrored to the calendar. When `existingEventId`
   * is provided the event is updated in place instead of created.
   */
  async pushRealtyVisitToCalendar(
    businessId: string,
    params: {
      staffId?: string | null;
      summary: string;
      description?: string;
      startAt: Date;
      endAt: Date;
      timeZone: string;
      location?: string;
      reminderMinutes?: number[];
      existingEventId?: string | null;
      existingCalendarId?: string | null;
    },
  ): Promise<{ eventId: string; calendarId: string } | null> {
    try {
      const connection = await this.repository.findConnection(
        businessId,
        params.staffId ?? null,
      );
      if (!connection || !connection.sync_enabled) {
        return null;
      }
      const accessToken = await this.ensureAccessToken(connection).catch(
        async (err) => {
          await this.handleCalendarAuthFailure(businessId, connection, err);
          return null;
        },
      );
      if (!accessToken) {
        return null;
      }

      const calendarId =
        params.existingCalendarId ?? connection.google_calendar_id ?? 'primary';
      const eventInput = {
        summary: params.summary,
        description: params.description,
        startAt: params.startAt,
        endAt: params.endAt,
        timeZone: params.timeZone,
        location: params.location,
        reminderMinutes: params.reminderMinutes ?? [120],
      };

      if (params.existingEventId) {
        await this.googleCalendar.updateEvent(
          accessToken,
          calendarId,
          params.existingEventId,
          eventInput,
        );
        return { eventId: params.existingEventId, calendarId };
      }
      const result = await this.googleCalendar.createEvent(
        accessToken,
        calendarId,
        eventInput,
      );
      return { eventId: result.eventId, calendarId };
    } catch (err) {
      this.logger.warn(
        `Non-fatal: could not sync realty visit to Google Calendar: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Remove a realty site-visit event from Google Calendar (best-effort). */
  async removeRealtyVisitFromCalendar(
    businessId: string,
    params: { staffId?: string | null; calendarId: string; eventId: string },
  ): Promise<void> {
    try {
      const connection = await this.repository.findConnection(
        businessId,
        params.staffId ?? null,
      );
      if (!connection) {
        return;
      }
      const accessToken = await this.ensureAccessToken(connection);
      await this.googleCalendar.deleteEvent(
        accessToken,
        params.calendarId,
        params.eventId,
      );
    } catch (err) {
      this.logger.warn(
        `Non-fatal: could not remove realty visit calendar event: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getCalendarConnection(
    businessId: string,
    staffId?: string,
  ): Promise<CalendarConnectionDto | null> {
    const connection = await this.repository.findConnection(
      businessId,
      staffId ?? null,
    );
    return connection ? this.toConnectionDto(connection) : null;
  }

  // ─── calendar internals ───

  private toConnectionDto(c: booking_calendar_connections): CalendarConnectionDto {
    return {
      id: c.id,
      businessId: c.business_id,
      staffId: c.staff_id,
      provider: c.provider,
      googleCalendarId: c.google_calendar_id,
      googleAccountEmail: c.google_account_email,
      syncEnabled: c.sync_enabled,
      lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
      lastSyncError: c.last_sync_error,
      connected: !!c.access_token && c.deleted_at === null,
    };
  }

  /** Best-effort push used after create/confirm/reschedule. Never throws. */
  private async pushBookingToCalendar(
    businessId: string,
    booking: bookings,
  ): Promise<void> {
    try {
      const connection = await this.repository.findConnection(
        businessId,
        booking.staff_id ?? null,
      );
      if (!connection || !connection.sync_enabled) {
        return;
      }
      const accessToken = await this.ensureAccessToken(connection).catch(
        async (err) => {
          await this.handleCalendarAuthFailure(businessId, connection, err);
          return null;
        },
      );
      if (!accessToken) {
        return;
      }
      await this.upsertCalendarEvent(booking, connection, accessToken);
    } catch (err) {
      this.logger.warn(
        `Non-fatal: could not sync booking ${booking.id} to Google Calendar: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async removeBookingFromCalendar(
    businessId: string,
    booking: bookings,
  ): Promise<void> {
    if (!booking.gcal_event_id || !booking.gcal_calendar_id) {
      return;
    }
    try {
      const connection = await this.repository.findConnection(
        businessId,
        booking.staff_id ?? null,
      );
      if (!connection) {
        return;
      }
      const accessToken = await this.ensureAccessToken(connection);
      await this.googleCalendar.deleteEvent(
        accessToken,
        booking.gcal_calendar_id,
        booking.gcal_event_id,
      );
    } catch (err) {
      this.logger.warn(
        `Non-fatal: could not remove calendar event for booking ${booking.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Create or update the Google event for a booking and persist its id. */
  private async upsertCalendarEvent(
    booking: bookings,
    connection: booking_calendar_connections,
    accessToken: string,
  ): Promise<void> {
    const calendarId = connection.google_calendar_id ?? 'primary';
    const eventInput = {
      summary: `Appointment — ${booking.client_id.slice(0, 8)}`,
      description: booking.notes ?? undefined,
      startAt: booking.start_at,
      endAt: booking.end_at,
      timeZone: booking.timezone,
      location: booking.location_address ?? undefined,
      reminderMinutes: [60],
    };

    if (booking.gcal_event_id) {
      await this.googleCalendar.updateEvent(
        accessToken,
        calendarId,
        booking.gcal_event_id,
        eventInput,
      );
    } else {
      const result = await this.googleCalendar.createEvent(
        accessToken,
        calendarId,
        eventInput,
      );
      await this.repository.updateBooking(booking.business_id, booking.id, {
        gcal_event_id: result.eventId,
        gcal_calendar_id: calendarId,
      });
    }
  }

  /** Return a valid access token, refreshing (and persisting) if near expiry. */
  private async ensureAccessToken(
    connection: booking_calendar_connections,
  ): Promise<string> {
    const expiresSoon =
      !connection.token_expires_at ||
      connection.token_expires_at.getTime() - Date.now() < 60_000;

    if (!expiresSoon && connection.access_token) {
      return connection.access_token;
    }
    if (!connection.refresh_token) {
      // The access token has expired and there is nothing to renew it with, so
      // the connection is unusable until the business re-authorises offline
      // access. Not the caller's fault, hence a configuration fault, not a 4xx.
      throw new ConfigurationError(
        'google.refreshToken',
        'No refresh token available for Google Calendar connection',
        { context: { businessId: connection.business_id, connectionId: connection.id } },
      );
    }

    const refreshed = await this.googleCalendar.refreshAccessToken(
      connection.refresh_token,
    );
    await this.repository.updateConnection(connection.business_id, connection.id, {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_expires_at: refreshed.expiresAt,
    });
    return refreshed.accessToken;
  }

  /** Record the failure and raise a HITL task so a human can re-authenticate. */
  private async handleCalendarAuthFailure(
    businessId: string,
    connection: booking_calendar_connections,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.repository
      .updateConnection(businessId, connection.id, { last_sync_error: message })
      .catch(() => undefined);

    const event: TaskCreatedEvent = {
      type: 'task.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      taskId: generateId(),
      conversationId: '',
      taskType: TaskType.CUSTOM,
      priority: TaskPriority.HIGH,
    };
    this.eventEmitter.emit('task.created', event);
    this.logger.error(
      `Google Calendar auth failed for business ${businessId}: ${message} — HITL task raised`,
    );
  }

  // ════════════════════════════════════════════
  // Reminders (Bull jobs)
  // ════════════════════════════════════════════

  /**
   * Schedule reminder jobs (24h + 1h before start). Re-scheduling clears stale
   * reminder jobs for the booking first so reschedules don't double-fire.
   */
  async scheduleReminders(businessId: string, bookingId: string): Promise<void> {
    const booking = await this.repository.findBookingById(businessId, bookingId);
    if (!booking) {
      return;
    }

    // Drop whatever is already scheduled for this booking before re-arming.
    //
    // The jobIds below are derived from the booking, so they are stable across
    // reschedules — and Bull *silently ignores* an add whose jobId already
    // exists (its addJob script returns the existing id and publishes a
    // `duplicated` event, which nothing here listens for). Without this clear
    // the re-arm was a no-op and the booking kept the reminders computed from
    // its **original** start time: move a booking from Monday 10:00 to Friday
    // 15:00 and the 24h reminder still pointed at Monday, so it fired against a
    // time the client no longer had — or, once that moment had passed, never
    // fired at all. Nothing surfaced it; `queue.add` resolves happily either way.
    await this.clearReminders(bookingId);

    for (const minutesBefore of DEFAULT_REMINDER_OFFSETS_MINUTES) {
      const fireAt = booking.start_at.getTime() - minutesBefore * 60_000;
      const delay = fireAt - Date.now();
      if (delay <= 0) {
        continue; // too late to schedule this reminder
      }
      const jobData: ReminderJobData = { businessId, bookingId, minutesBefore };
      await this.queue.add(BOOKING_JOBS.REMINDER, jobData, {
        delay,
        jobId: `reminder:${bookingId}:${minutesBefore}`,
      });
    }
    this.logger.debug(`Scheduled reminders for booking ${bookingId}`);
  }

  /**
   * Remove this booking's pending reminder jobs.
   *
   * Best-effort: a Redis hiccup here must not fail the reschedule that the
   * client already sees as committed. The worst case is the stale-reminder
   * behaviour this exists to prevent, which `fireReminder` still guards against
   * by re-reading the booking before emitting.
   */
  private async clearReminders(bookingId: string): Promise<void> {
    try {
      await this.queue.removeJobs(`reminder:${bookingId}:*`);
    } catch (err) {
      this.logger.warn(
        `Could not clear reminder jobs for booking ${bookingId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async scheduleAutoCancel(
    businessId: string,
    bookingId: string,
  ): Promise<void> {
    const jobData: AutoCancelJobData = { businessId, bookingId };
    await this.queue.add(BOOKING_JOBS.AUTO_CANCEL, jobData, {
      delay: AUTO_CANCEL_PENDING_HOURS * 3_600_000,
      jobId: `autocancel:${bookingId}`,
    });
  }

  /**
   * Invoked by the processor at reminder time. Emits `booking.reminder` if the
   * booking is still active, and records that a reminder was sent.
   */
  async fireReminder(
    businessId: string,
    bookingId: string,
    minutesBefore: number,
  ): Promise<void> {
    const booking = await this.repository.findBookingById(businessId, bookingId);
    if (!booking) {
      return;
    }
    const status = booking.status as BookingStatus;
    if (
      status === BookingStatus.CANCELLED ||
      status === BookingStatus.COMPLETED ||
      status === BookingStatus.NO_SHOW
    ) {
      return;
    }

    const event: BookingReminderEvent = {
      type: 'booking.reminder',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: booking.id,
      clientId: booking.client_id,
      catalogItemId: booking.catalog_item_id ?? undefined,
      staffMemberId: booking.staff_id ?? undefined,
      startAt: booking.start_at.toISOString(),
      minutesBefore,
    };
    this.eventEmitter.emit('booking.reminder', event);

    await this.repository.updateBooking(businessId, bookingId, {
      reminders_sent: { increment: 1 },
      last_reminder_at: new Date(),
    });
    this.logger.log(
      `Reminder emitted for booking ${bookingId} (${minutesBefore}m before)`,
    );
  }

  /**
   * Invoked by the processor 24h after a PENDING booking. Cancels it if still
   * unpaid/pending. Uses CAS so a payment that confirmed the booking between
   * the read and the write does not get overwritten.
   */
  async autoCancelIfUnpaid(
    businessId: string,
    bookingId: string,
  ): Promise<void> {
    const booking = await this.repository.findBookingById(businessId, bookingId);
    if (!booking || (booking.status as BookingStatus) !== BookingStatus.PENDING) {
      return;
    }
    const reason = 'Auto-cancelled: payment not received within 24 hours';
    const updated = await this.repository.transitionStatus(
      businessId, bookingId, BookingStatus.PENDING,
      {
        status: BookingStatus.CANCELLED,
        cancelled_at: new Date(),
        cancellation_reason: reason,
        cancelled_by: BookingActor.SYSTEM,
      },
    );
    if (!updated) {
      this.logger.debug(`Booking ${bookingId} no longer PENDING — auto-cancel skipped`);
      return;
    }

    await this.removeBookingFromCalendar(businessId, updated);

    const event: BookingCancelledEvent = {
      type: 'booking.cancelled',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      bookingId: updated.id,
      clientId: updated.client_id,
      cancelledBy: BookingActor.SYSTEM,
      reason,
    };
    this.eventEmitter.emit('booking.cancelled', event);

    this.logger.log(`Booking ${bookingId} auto-cancelled (unpaid PENDING)`);
  }

  // ════════════════════════════════════════════
  // Event handlers
  // ════════════════════════════════════════════

  /**
   * Auto-confirm a booking when its associated payment succeeds.
   * The payment event carries a `bookingId` (set when the link was created).
   */

  /**
   * Staff roster for the booking assignment picker.
   *
   * Best-effort: a failed read degrades to an empty roster rather than breaking
   * the bookings page, which is usable without staff assignment.
   *
   * Bounded at {@link STAFF_ROSTER_LIMIT} and ordered by name so the dropdown is
   * stable across reloads. Soft-deleted members are excluded — a removed staff
   * member must not remain assignable.
   */
  async getStaffMembers(businessId: string): Promise<{ staff: StaffMemberDto[] }> {
    try {
      const members = await this.prisma.team_members.findMany({
        where: { business_id: businessId, deleted_at: null },
        select: { id: true, name: true, email: true, role: true, avatar_url: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: STAFF_ROSTER_LIMIT,
      });
      return {
        staff: (members ?? []).map((m) => ({
          id: m.id,
          // A member invited by email may have no display name yet.
          name: m.name || m.email?.split('@')[0] || 'Staff',
          email: m.email,
          role: m.role,
          avatarUrl: m.avatar_url ?? null,
        })),
      };
    } catch (err) {
      this.logger.warn(
        `Staff roster query failed for business ${businessId}; ` +
          `returning empty: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { staff: [] };
    }
  }

  @OnEvent('payment.success')
  async handlePaymentSuccess(event: PaymentSuccessEvent): Promise<void> {
    const bookingId = (event as PaymentSuccessEvent & { bookingId?: string }).bookingId;
    if (!bookingId) {
      return;
    }
    try {
      const booking = await this.repository.findBookingById(
        event.businessId,
        bookingId,
      );
      if (!booking || (booking.status as BookingStatus) !== BookingStatus.PENDING) {
        return;
      }
      await this.repository.updateBooking(event.businessId, bookingId, {
        payment_id: event.paymentId ?? null,
      });
      await this.confirmBooking(event.businessId, bookingId);
      this.logger.log(
        `Booking ${bookingId} auto-confirmed after payment ${event.paymentId}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to confirm booking ${bookingId} on payment success: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ════════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════════

  private async requireBooking(
    businessId: string,
    bookingId: string,
  ): Promise<bookings> {
    const booking = await this.repository.findBookingById(businessId, bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }

  /** Capacity for a scope: a named staff member is always a single resource. */
  private async resolveCapacity(
    businessId: string,
    staffId: string | null,
  ): Promise<number> {
    if (staffId) {
      return 1;
    }
    const availability = await this.repository.findAvailability(businessId, null);
    return availability?.capacity_per_slot ?? 1;
  }

  /** Reject past times and blocked ranges before booking. */
  private async assertSlotBookable(
    businessId: string,
    staffId: string | null,
    startAt: Date,
    endAt: Date,
    excludeBookingId?: string,
  ): Promise<void> {
    if (endAt <= startAt) {
      throw new BadRequestException('Booking end must be after start');
    }
    if (startAt.getTime() <= Date.now()) {
      throw new BadRequestException('Cannot book a time in the past');
    }
    const blocks = await this.repository.findBlocksInRange(
      businessId,
      staffId,
      startAt,
      endAt,
    );
    if (blocks.length > 0) {
      throw new BadRequestException(
        'Requested time falls within a blocked period',
      );
    }
    // Capacity is enforced atomically at insert time; for reschedule we also
    // pre-check so we can surface a clean error before mutating.
    if (excludeBookingId) {
      const capacity = await this.resolveCapacity(businessId, staffId);
      const overlapping = await this.repository.countOverlapping(
        businessId,
        staffId,
        startAt,
        endAt,
        excludeBookingId,
      );
      if (overlapping >= capacity) {
        throw new BadRequestException('Requested slot is fully booked');
      }
    }
  }

  private parseInstant(value: string, field: string): Date {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new BadRequestException(`Invalid ISO-8601 date for ${field}: ${value}`);
    }
    return new Date(ms);
  }
}
