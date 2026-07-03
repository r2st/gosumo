import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { realty_site_visits } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreateVisitData {
  businessId: string;
  leadId: string;
  projectId: string;
  unitId?: string | null;
  assignedAgentId?: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  timezone: string;
  bookingId?: string | null;
  calendarEventId?: string | null;
  calendarId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Persisted visit field updates. Only provided fields are written. */
export interface UpdateVisitData {
  scheduledAt?: Date;
  durationMinutes?: number;
  status?: realty_site_visits['status'];
  assignedAgentId?: string | null;
  unitId?: string | null;
  calendarEventId?: string | null;
  calendarId?: string | null;
  reminderState?: Prisma.InputJsonValue;
  remindersSent?: number | { increment: number };
  lastReminderAt?: Date | null;
  feedback?: string | null;
  outcome?: realty_site_visits['outcome'];
  rescheduledFrom?: Date | null;
  cancellationReason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface VisitListFilters {
  status?: string;
  leadId?: string;
  assignedAgentId?: string;
  from?: Date;
  to?: Date;
  /** Future + non-terminal (BOOKED/CONFIRMED/RESCHEDULED) only. */
  upcoming?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedVisits {
  data: realty_site_visits[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const TERMINAL_STATUSES = ['COMPLETED', 'NO_SHOW', 'CANCELLED'];
const ACTIVE_STATUSES = ['BOOKED', 'CONFIRMED', 'RESCHEDULED'];

/**
 * RealtyVisitsRepository — all Prisma queries for `realty_site_visits`.
 * Every query is scoped by business_id; soft-deleted rows are excluded.
 */
@Injectable()
export class RealtyVisitsRepository {
  private readonly logger = new Logger(RealtyVisitsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateVisitData): Promise<realty_site_visits> {
    return this.prisma.realty_site_visits.create({
      data: {
        business_id: data.businessId,
        lead_id: data.leadId,
        project_id: data.projectId,
        unit_id: data.unitId ?? null,
        assigned_agent_id: data.assignedAgentId ?? null,
        scheduled_at: data.scheduledAt,
        duration_minutes: data.durationMinutes,
        timezone: data.timezone,
        booking_id: data.bookingId ?? null,
        calendar_event_id: data.calendarEventId ?? null,
        calendar_id: data.calendarId ?? null,
        metadata: data.metadata ?? {},
      },
    });
  }

  async findById(businessId: string, visitId: string): Promise<realty_site_visits | null> {
    return this.prisma.realty_site_visits.findFirst({
      where: { id: visitId, business_id: businessId, deleted_at: null },
    });
  }

  async update(
    businessId: string,
    visitId: string,
    data: UpdateVisitData,
  ): Promise<realty_site_visits> {
    const d: Record<string, unknown> = {};
    if (data.scheduledAt !== undefined) d['scheduled_at'] = data.scheduledAt;
    if (data.durationMinutes !== undefined) d['duration_minutes'] = data.durationMinutes;
    if (data.status !== undefined) d['status'] = data.status;
    if (data.assignedAgentId !== undefined) d['assigned_agent_id'] = data.assignedAgentId;
    if (data.unitId !== undefined) d['unit_id'] = data.unitId;
    if (data.calendarEventId !== undefined) d['calendar_event_id'] = data.calendarEventId;
    if (data.calendarId !== undefined) d['calendar_id'] = data.calendarId;
    if (data.reminderState !== undefined) d['reminder_state'] = data.reminderState;
    if (data.remindersSent !== undefined) d['reminders_sent'] = data.remindersSent;
    if (data.lastReminderAt !== undefined) d['last_reminder_at'] = data.lastReminderAt;
    if (data.feedback !== undefined) d['feedback'] = data.feedback;
    if (data.outcome !== undefined) d['outcome'] = data.outcome;
    if (data.rescheduledFrom !== undefined) d['rescheduled_from'] = data.rescheduledFrom;
    if (data.cancellationReason !== undefined) d['cancellation_reason'] = data.cancellationReason;
    if (data.metadata !== undefined) d['metadata'] = data.metadata;

    return this.prisma.realty_site_visits.update({ where: { id: visitId }, data: d });
  }

  async softDelete(businessId: string, visitId: string): Promise<realty_site_visits> {
    return this.prisma.realty_site_visits.update({
      where: { id: visitId },
      data: { deleted_at: new Date() },
    });
  }

  async list(businessId: string, filters: VisitListFilters): Promise<PaginatedVisits> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.realty_site_visits.findMany({
        where,
        orderBy: [{ scheduled_at: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.realty_site_visits.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Visit counts by status — the source for the show-up + visits/100 KPIs. */
  async statusCounts(businessId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.realty_site_visits.groupBy({
      by: ['status'],
      where: { business_id: businessId, deleted_at: null },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  /** All active + non-deleted visits in a time range — powers the calendar view. */
  async listInRange(
    businessId: string,
    from: Date,
    to: Date,
  ): Promise<realty_site_visits[]> {
    return this.prisma.realty_site_visits.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        scheduled_at: { gte: from, lte: to },
      },
      orderBy: [{ scheduled_at: 'asc' }],
    });
  }

  private buildWhere(
    businessId: string,
    filters: VisitListFilters,
  ): Prisma.realty_site_visitsWhereInput {
    const where: Prisma.realty_site_visitsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.status) where.status = filters.status as realty_site_visits['status'];
    if (filters.leadId) where.lead_id = filters.leadId;
    if (filters.assignedAgentId) where.assigned_agent_id = filters.assignedAgentId;

    const scheduledAt: Prisma.DateTimeFilter = {};
    if (filters.from) scheduledAt.gte = filters.from;
    if (filters.to) scheduledAt.lte = filters.to;
    if (filters.upcoming) {
      scheduledAt.gte = filters.from && filters.from > new Date() ? filters.from : new Date();
      where.status = { in: ACTIVE_STATUSES as realty_site_visits['status'][] };
    }
    if (Object.keys(scheduledAt).length > 0) where.scheduled_at = scheduledAt;
    return where;
  }
}

export { TERMINAL_STATUSES, ACTIVE_STATUSES };
