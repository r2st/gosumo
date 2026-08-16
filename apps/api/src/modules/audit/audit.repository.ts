import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, audit_logs } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { MAX_AUDIT_EXPORT_ROWS } from './audit.constants';

/** Every filter the read API supports, already normalised. */
export interface AuditLogFilters {
  from: Date;
  to: Date;
  actions?: AuditAction[];
  actorType?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
}

/** One page of audit rows plus the total matching the same filters. */
export interface AuditLogPage {
  rows: audit_logs[];
  total: number;
}

/**
 * AuditRepository — reads over the append-only `audit_logs` table.
 *
 * Reads only. The table has database triggers refusing UPDATE and DELETE, so a
 * write method here would be a runtime error waiting to be called; the one
 * legitimate writer is `AuditLogService.record`.
 *
 * Every query carries `business_id`. Rows with a null `business_id` are
 * platform-level events and are deliberately invisible to tenants — an equality
 * predicate excludes NULL in SQL, which is the behaviour wanted here, but it is
 * load-bearing rather than incidental so it is asserted in the spec.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Build the shared predicate. Tenant first, so it is impossible to forget. */
  private where(businessId: string, filters: AuditLogFilters): Prisma.audit_logsWhereInput {
    return {
      business_id: businessId,
      created_at: { gte: filters.from, lte: filters.to },
      ...(filters.actions?.length ? { action: { in: filters.actions } } : {}),
      ...(filters.actorType ? { actor_type: filters.actorType } : {}),
      ...(filters.actorId ? { actor_id: filters.actorId } : {}),
      ...(filters.resourceType ? { resource_type: filters.resourceType } : {}),
      ...(filters.resourceId ? { resource_id: filters.resourceId } : {}),
    };
  }

  /**
   * One page, newest first, with the total.
   *
   * Ordered by `created_at DESC, id DESC` rather than `created_at` alone: the
   * column is a timestamp and two rows written in the same transaction can
   * share it exactly, which would let a row appear on two consecutive pages —
   * or on neither — as the tie broke differently per query.
   */
  async list(
    businessId: string,
    filters: AuditLogFilters,
    skip: number,
    take: number,
  ): Promise<AuditLogPage> {
    const where = this.where(businessId, filters);

    const [rows, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    return { rows, total };
  }

  /** One row, scoped to the tenant. */
  async findById(businessId: string, id: string): Promise<audit_logs | null> {
    return this.prisma.audit_logs.findFirst({
      where: { id, business_id: businessId },
    });
  }

  /**
   * Every row matching the filters, up to a hard ceiling.
   *
   * For export callers that want the window rather than a page. Bounded because
   * everything downstream buffers the result.
   */
  async listAll(
    businessId: string,
    filters: AuditLogFilters,
    limit: number = MAX_AUDIT_EXPORT_ROWS,
  ): Promise<audit_logs[]> {
    return this.prisma.audit_logs.findMany({
      where: this.where(businessId, filters),
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: Math.min(limit, MAX_AUDIT_EXPORT_ROWS),
    });
  }

  /** Counts per action over the window, for the dashboard's summary strip. */
  async countByAction(
    businessId: string,
    filters: AuditLogFilters,
  ): Promise<Array<{ action: AuditAction; count: number }>> {
    const grouped = await this.prisma.audit_logs.groupBy({
      by: ['action'],
      where: this.where(businessId, filters),
      _count: { _all: true },
    });
    return grouped.map((row) => ({ action: row.action, count: row._count._all }));
  }

  /** Counts per actor over the window, so "who was busiest" is one query. */
  async countByActor(
    businessId: string,
    filters: AuditLogFilters,
  ): Promise<Array<{ actorId: string | null; actorEmail: string | null; count: number }>> {
    const grouped = await this.prisma.audit_logs.groupBy({
      by: ['actor_id', 'actor_email'],
      where: this.where(businessId, filters),
      _count: { _all: true },
    });
    return grouped.map((row) => ({
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      count: row._count._all,
    }));
  }
}
