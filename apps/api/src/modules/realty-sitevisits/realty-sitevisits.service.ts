import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import type { realty_site_visits } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  SiteVisitStatus,
  LeadStage,
} from '@gosumo/shared';
import type {
  RealtyVisitBookedEvent,
  RealtyVisitConfirmedEvent,
  RealtyVisitRescheduledEvent,
  RealtyVisitCancelledEvent,
  RealtyVisitCompletedEvent,
  RealtyVisitNoShowEvent,
  RealtyVisitReminderEvent,
} from '@gosumo/shared';
import { RealtyVisitsRepository } from './realty-sitevisits.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { BookingService } from '../booking/booking.service';
import { TenantService } from '../tenant/tenant.service';
import {
  REALTY_VISITS_QUEUE,
  REALTY_VISIT_JOBS,
  VISIT_REMINDER_OFFSETS_MINUTES,
  DEFAULT_VISIT_DURATION_MINUTES,
  CALENDAR_MAX_RANGE_DAYS,
  VisitReminderJobData,
} from './realty-sitevisits.constants';
import {
  BookVisitDto,
  RescheduleVisitDto,
  CancelVisitDto,
  CompleteVisitDto,
  ListVisitsQueryDto,
} from './dto';

const IST_TIMEZONE = 'Asia/Kolkata';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// Response DTO
// ─────────────────────────────────────────────

export interface SiteVisitDto {
  id: string;
  businessId: string;
  leadId: string;
  projectId: string;
  unitId: string | null;
  assignedAgentId: string | null;
  scheduledAt: string;
  durationMinutes: number;
  timezone: string;
  status: string;
  bookingId: string | null;
  calendarEventId: string | null;
  calendarId: string | null;
  reminderState: Record<string, boolean>;
  remindersSent: number;
  lastReminderAt: string | null;
  feedback: string | null;
  outcome: string;
  rescheduledFrom: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * RealtyVisitsService — the site-visit lifecycle (blueprint §14, Phase 3).
 *
 * Books property visits on top of the `booking` module's Google Calendar OAuth,
 * runs the realty reminder cadence (T-24h, T-2h) via a dedicated Bull queue,
 * drives the lead pipeline (→ VISIT_BOOKED on booking, → VISITED on completion),
 * and captures post-visit feedback + outcome. All state transitions emit typed
 * `realty.visit.*` domain events.
 */
@Injectable()
export class RealtyVisitsService {
  private readonly logger = new Logger(RealtyVisitsService.name);

  constructor(
    private readonly repository: RealtyVisitsRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly leadsService: RealtyLeadsService,
    private readonly bookingService: BookingService,
    private readonly tenantService: TenantService,
    @InjectQueue(REALTY_VISITS_QUEUE) private readonly queue: Queue,
  ) {}

  // ════════════════════════════════════════════
  // Booking
  // ════════════════════════════════════════════

  /**
   * Book a site visit: persist it, advance the lead to VISIT_BOOKED, mirror it
   * to Google Calendar (best-effort), schedule T-24h / T-2h reminders, and emit
   * `realty.visit.booked`.
   */
  async bookVisit(businessId: string, dto: BookVisitDto): Promise<SiteVisitDto> {
    const scheduledAt = this.parseFutureInstant(dto.scheduledAt, 'scheduledAt');
    const duration = dto.durationMinutes ?? DEFAULT_VISIT_DURATION_MINUTES;
    const timezone = dto.timezone ?? IST_TIMEZONE;

    // Body-supplied agent id: scope it before it is written, and before it
    // reaches the calendar push below as `staffId`.
    if (dto.assignedAgentId) {
      await this.tenantService.assertTeamMember(businessId, dto.assignedAgentId);
    }

    const visit = await this.repository.create({
      businessId,
      leadId: dto.leadId,
      projectId: dto.projectId,
      unitId: dto.unitId ?? null,
      assignedAgentId: dto.assignedAgentId ?? null,
      scheduledAt,
      durationMinutes: duration,
      timezone,
      metadata: dto.notes ? { notes: dto.notes } : {},
    });

    // Advance the lead pipeline (synchronous cross-module write — sanctioned).
    await this.transitionLeadSafely(businessId, dto.leadId, LeadStage.VISIT_BOOKED);

    // Mirror onto Google Calendar via the booking module's OAuth connection.
    const calendar = await this.bookingService.pushRealtyVisitToCalendar(businessId, {
      staffId: dto.staffId ?? dto.assignedAgentId ?? null,
      summary: `Site visit — lead ${dto.leadId.slice(0, 8)}`,
      description: dto.notes ?? undefined,
      startAt: scheduledAt,
      endAt: new Date(scheduledAt.getTime() + duration * 60_000),
      timeZone: timezone,
      reminderMinutes: [120],
    });

    let persisted = visit;
    if (calendar) {
      persisted = await this.repository.update(businessId, visit.id, {
        calendarEventId: calendar.eventId,
        calendarId: calendar.calendarId,
        metadata: {
          ...(visit.metadata as Record<string, unknown>),
          calendarStaffId: dto.staffId ?? dto.assignedAgentId ?? null,
        } as Prisma.InputJsonValue,
      });
    }

    await this.scheduleReminders(businessId, visit.id, scheduledAt);

    this.emit<RealtyVisitBookedEvent>('realty.visit.booked', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.booked',
      visitId: visit.id,
      leadId: dto.leadId,
      projectId: dto.projectId,
      unitId: dto.unitId ?? undefined,
      scheduledAt: scheduledAt.toISOString(),
      assignedAgentId: dto.assignedAgentId ?? undefined,
    });

    this.logger.log(
      `Booked visit ${visit.id} for lead ${dto.leadId} at ${scheduledAt.toISOString()}`,
    );
    return this.mapResponse(persisted);
  }

  // ════════════════════════════════════════════
  // Retrieval
  // ════════════════════════════════════════════

  async getVisit(businessId: string, visitId: string): Promise<SiteVisitDto> {
    return this.mapResponse(await this.mustFind(businessId, visitId));
  }

  async listVisits(businessId: string, query: ListVisitsQueryDto) {
    const result = await this.repository.list(businessId, {
      status: query.status,
      leadId: query.leadId,
      assignedAgentId: query.assignedAgentId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      upcoming: query.upcoming,
      page: query.page,
      limit: query.limit,
    });
    return {
      data: result.data.map((v) => this.mapResponse(v)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Aggregate visit stats for the launch-readiness gate (Phase 8): total visits
   * (for visits/100-leads) and completed vs no-show (for the show-up rate).
   */
  async getVisitStats(
    businessId: string,
  ): Promise<{ total: number; completed: number; noShow: number }> {
    const counts = await this.repository.statusCounts(businessId);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { total, completed: counts['COMPLETED'] ?? 0, noShow: counts['NO_SHOW'] ?? 0 };
  }

  /**
   * Visits within a date range for the calendar view.
   *
   * The span is capped: `from`/`to` come straight from the query string, and
   * without a ceiling `from=1970-01-01&to=2999-01-01` read every visit the
   * tenant has ever booked into memory and mapped all of it to DTOs — an
   * unbounded response any authenticated user could ask for. A year covers
   * every real calendar view; wider queries belong on the paginated list.
   */
  async getCalendar(businessId: string, from: string, to: string): Promise<SiteVisitDto[]> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (toDate <= fromDate) {
      throw new BadRequestException('`to` must be after `from`');
    }
    const spanDays = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY;
    if (spanDays > CALENDAR_MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Calendar range must not exceed ${CALENDAR_MAX_RANGE_DAYS} days (requested ${Math.ceil(spanDays)}). ` +
          'Use the paginated visit list for wider queries.',
      );
    }
    const visits = await this.repository.listInRange(businessId, fromDate, toDate);
    return visits.map((v) => this.mapResponse(v));
  }

  // ════════════════════════════════════════════
  // Lifecycle transitions
  // ════════════════════════════════════════════

  /** Buyer confirmed attendance: BOOKED/RESCHEDULED → CONFIRMED. */
  async confirmVisit(businessId: string, visitId: string): Promise<SiteVisitDto> {
    const visit = await this.mustFind(businessId, visitId);
    this.assertNotTerminal(visit, 'confirm');

    const updated = await this.repository.update(businessId, visitId, {
      status: SiteVisitStatus.CONFIRMED as realty_site_visits['status'],
    });

    this.emit<RealtyVisitConfirmedEvent>('realty.visit.confirmed', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.confirmed',
      visitId,
      leadId: visit.lead_id,
      scheduledAt: visit.scheduled_at.toISOString(),
    });
    this.logger.log(`Visit ${visitId} confirmed`);
    return this.mapResponse(updated);
  }

  /**
   * Move a visit to a new time: updates the calendar event, resets reminder
   * state, re-schedules the T-24h / T-2h jobs, and emits `realty.visit.rescheduled`.
   */
  async rescheduleVisit(
    businessId: string,
    visitId: string,
    dto: RescheduleVisitDto,
  ): Promise<SiteVisitDto> {
    const visit = await this.mustFind(businessId, visitId);
    this.assertNotTerminal(visit, 'reschedule');

    const newScheduledAt = this.parseFutureInstant(dto.newScheduledAt, 'newScheduledAt');
    const duration = dto.durationMinutes ?? visit.duration_minutes;
    const oldScheduledAt = visit.scheduled_at;

    // Update the mirrored calendar event in place (best-effort).
    const staffId = this.readCalendarStaffId(visit);
    const calendar = await this.bookingService.pushRealtyVisitToCalendar(businessId, {
      staffId,
      summary: `Site visit — lead ${visit.lead_id.slice(0, 8)}`,
      startAt: newScheduledAt,
      endAt: new Date(newScheduledAt.getTime() + duration * 60_000),
      timeZone: visit.timezone,
      reminderMinutes: [120],
      existingEventId: visit.calendar_event_id,
      existingCalendarId: visit.calendar_id,
    });

    const updated = await this.repository.update(businessId, visitId, {
      status: SiteVisitStatus.RESCHEDULED as realty_site_visits['status'],
      scheduledAt: newScheduledAt,
      durationMinutes: duration,
      rescheduledFrom: oldScheduledAt,
      reminderState: {},
      calendarEventId: calendar?.eventId ?? visit.calendar_event_id,
      calendarId: calendar?.calendarId ?? visit.calendar_id,
    });

    await this.scheduleReminders(businessId, visitId, newScheduledAt);

    this.emit<RealtyVisitRescheduledEvent>('realty.visit.rescheduled', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.rescheduled',
      visitId,
      leadId: visit.lead_id,
      oldScheduledAt: oldScheduledAt.toISOString(),
      newScheduledAt: newScheduledAt.toISOString(),
    });
    this.logger.log(
      `Visit ${visitId} rescheduled ${oldScheduledAt.toISOString()} → ${newScheduledAt.toISOString()}`,
    );
    return this.mapResponse(updated);
  }

  /** Cancel a visit: removes the calendar event, cancels reminders, emits event. */
  async cancelVisit(
    businessId: string,
    visitId: string,
    dto: CancelVisitDto,
  ): Promise<SiteVisitDto> {
    const visit = await this.mustFind(businessId, visitId);
    if (visit.status === SiteVisitStatus.CANCELLED) {
      throw new BadRequestException('Visit is already cancelled');
    }
    if (visit.status === SiteVisitStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed visit');
    }

    if (visit.calendar_event_id && visit.calendar_id) {
      await this.bookingService.removeRealtyVisitFromCalendar(businessId, {
        staffId: this.readCalendarStaffId(visit),
        calendarId: visit.calendar_id,
        eventId: visit.calendar_event_id,
      });
    }
    await this.clearReminders(visitId);

    const updated = await this.repository.update(businessId, visitId, {
      status: SiteVisitStatus.CANCELLED as realty_site_visits['status'],
      cancellationReason: dto.reason ?? null,
    });

    this.emit<RealtyVisitCancelledEvent>('realty.visit.cancelled', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.cancelled',
      visitId,
      leadId: visit.lead_id,
      reason: dto.reason,
    });
    this.logger.log(`Visit ${visitId} cancelled: ${dto.reason ?? 'no reason'}`);
    return this.mapResponse(updated);
  }

  /**
   * Mark a visit COMPLETED with post-visit feedback + outcome, advance the lead
   * to VISITED, and emit `realty.visit.completed` (carries the outcome).
   */
  async completeVisit(
    businessId: string,
    visitId: string,
    dto: CompleteVisitDto,
  ): Promise<SiteVisitDto> {
    const visit = await this.mustFind(businessId, visitId);
    if (visit.status === SiteVisitStatus.CANCELLED) {
      throw new BadRequestException('Cannot complete a cancelled visit');
    }

    await this.clearReminders(visitId);

    const updated = await this.repository.update(businessId, visitId, {
      status: SiteVisitStatus.COMPLETED as realty_site_visits['status'],
      feedback: dto.feedback ?? null,
      outcome: dto.outcome as realty_site_visits['outcome'],
    });

    await this.transitionLeadSafely(businessId, visit.lead_id, LeadStage.VISITED);

    this.emit<RealtyVisitCompletedEvent>('realty.visit.completed', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.completed',
      visitId,
      leadId: visit.lead_id,
      projectId: visit.project_id,
      outcome: dto.outcome,
    });
    this.logger.log(`Visit ${visitId} completed (outcome=${dto.outcome})`);
    return this.mapResponse(updated);
  }

  /** Buyer did not show up: → NO_SHOW, cancel reminders, emit event. */
  async markNoShow(businessId: string, visitId: string): Promise<SiteVisitDto> {
    const visit = await this.mustFind(businessId, visitId);
    if (
      visit.status === SiteVisitStatus.CANCELLED ||
      visit.status === SiteVisitStatus.COMPLETED ||
      visit.status === SiteVisitStatus.NO_SHOW
    ) {
      // NO_SHOW → NO_SHOW is not a harmless repeat: it re-emits
      // realty.visit.no_show, and every listener sees a second no-show.
      throw new BadRequestException(`Cannot mark a ${visit.status} visit as no-show`);
    }
    await this.clearReminders(visitId);

    const updated = await this.repository.update(businessId, visitId, {
      status: SiteVisitStatus.NO_SHOW as realty_site_visits['status'],
    });

    this.emit<RealtyVisitNoShowEvent>('realty.visit.no_show', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.no_show',
      visitId,
      leadId: visit.lead_id,
      scheduledAt: visit.scheduled_at.toISOString(),
    });
    this.logger.warn(`Visit ${visitId} marked NO_SHOW`);
    return this.mapResponse(updated);
  }

  async deleteVisit(businessId: string, visitId: string): Promise<void> {
    await this.mustFind(businessId, visitId);
    await this.clearReminders(visitId);
    await this.repository.softDelete(businessId, visitId);
  }

  // ════════════════════════════════════════════
  // Reminders (Bull jobs)
  // ════════════════════════════════════════════

  /**
   * (Re)schedule the T-24h / T-2h reminder jobs. Stale jobs for this visit are
   * removed first so a reschedule never double-fires. Offsets already in the
   * past (visit is <2h away) are skipped.
   */
  async scheduleReminders(
    businessId: string,
    visitId: string,
    scheduledAt: Date,
  ): Promise<void> {
    await this.clearReminders(visitId);
    for (const minutesBefore of VISIT_REMINDER_OFFSETS_MINUTES) {
      const delay = scheduledAt.getTime() - minutesBefore * 60_000 - Date.now();
      if (delay <= 0) continue;
      const jobData: VisitReminderJobData = { businessId, visitId, minutesBefore };
      await this.queue.add(REALTY_VISIT_JOBS.REMINDER, jobData, {
        delay,
        jobId: `visit-reminder:${visitId}:${minutesBefore}`,
      });
    }
    this.logger.debug(`Scheduled reminders for visit ${visitId}`);
  }

  private async clearReminders(visitId: string): Promise<void> {
    try {
      await this.queue.removeJobs(`visit-reminder:${visitId}:*`);
    } catch (err) {
      this.logger.warn(
        `Could not clear reminder jobs for visit ${visitId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Invoked by the processor at reminder time. Emits `realty.visit.reminder`
   * if the visit is still active, and records that the reminder fired.
   */
  async fireReminder(
    businessId: string,
    visitId: string,
    minutesBefore: number,
  ): Promise<void> {
    const visit = await this.repository.findById(businessId, visitId);
    if (!visit) return;
    if (
      visit.status === SiteVisitStatus.CANCELLED ||
      visit.status === SiteVisitStatus.COMPLETED ||
      visit.status === SiteVisitStatus.NO_SHOW
    ) {
      return;
    }

    const reminderState = {
      ...(visit.reminder_state as Record<string, boolean>),
      [String(minutesBefore)]: true,
    };
    await this.repository.update(businessId, visitId, {
      reminderState: reminderState as Prisma.InputJsonValue,
      remindersSent: { increment: 1 },
      lastReminderAt: new Date(),
    });

    this.emit<RealtyVisitReminderEvent>('realty.visit.reminder', {
      ...this.baseEvent(businessId),
      type: 'realty.visit.reminder',
      visitId,
      leadId: visit.lead_id,
      scheduledAt: visit.scheduled_at.toISOString(),
      minutesBefore,
    });
    this.logger.log(`Reminder emitted for visit ${visitId} (${minutesBefore}m before)`);
  }

  // ════════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════════

  private async mustFind(businessId: string, visitId: string): Promise<realty_site_visits> {
    const visit = await this.repository.findById(businessId, visitId);
    if (!visit) throw new NotFoundException('Site visit not found');
    return visit;
  }

  private assertNotTerminal(visit: realty_site_visits, action: string): void {
    if (
      visit.status === SiteVisitStatus.CANCELLED ||
      visit.status === SiteVisitStatus.COMPLETED ||
      visit.status === SiteVisitStatus.NO_SHOW
    ) {
      throw new BadRequestException(`Cannot ${action} a ${visit.status} visit`);
    }
  }

  /**
   * Advance the lead pipeline without letting a lead error abort the visit op.
   * `advanceStage` is forward-only, so a repeat visit for a NEGOTIATING or
   * closed lead leaves its stage alone instead of dragging it back.
   */
  private async transitionLeadSafely(
    businessId: string,
    leadId: string,
    stage: LeadStage,
  ): Promise<void> {
    try {
      await this.leadsService.advanceStage(businessId, leadId, stage);
    } catch (err) {
      this.logger.warn(
        `Could not transition lead ${leadId} to ${stage}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private readCalendarStaffId(visit: realty_site_visits): string | null {
    const staffId = (visit.metadata as Record<string, unknown>)?.['calendarStaffId'];
    return typeof staffId === 'string' ? staffId : visit.assigned_agent_id;
  }

  private parseFutureInstant(value: string, field: string): Date {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new BadRequestException(`Invalid ISO-8601 date for ${field}: ${value}`);
    }
    const date = new Date(ms);
    if (date.getTime() <= Date.now()) {
      throw new BadRequestException(`${field} must be in the future`);
    }
    return date;
  }

  private baseEvent(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }

  private emit<T>(name: string, payload: T): void {
    this.eventEmitter.emit(name, payload);
  }

  private mapResponse(v: realty_site_visits): SiteVisitDto {
    return {
      id: v.id,
      businessId: v.business_id,
      leadId: v.lead_id,
      projectId: v.project_id,
      unitId: v.unit_id,
      assignedAgentId: v.assigned_agent_id,
      scheduledAt: v.scheduled_at.toISOString(),
      durationMinutes: v.duration_minutes,
      timezone: v.timezone,
      status: v.status,
      bookingId: v.booking_id,
      calendarEventId: v.calendar_event_id,
      calendarId: v.calendar_id,
      reminderState: (v.reminder_state as Record<string, boolean>) ?? {},
      remindersSent: v.reminders_sent,
      lastReminderAt: v.last_reminder_at?.toISOString() ?? null,
      feedback: v.feedback,
      outcome: v.outcome,
      rescheduledFrom: v.rescheduled_from?.toISOString() ?? null,
      cancellationReason: v.cancellation_reason,
      createdAt: v.created_at.toISOString(),
      updatedAt: v.updated_at.toISOString(),
    };
  }
}
