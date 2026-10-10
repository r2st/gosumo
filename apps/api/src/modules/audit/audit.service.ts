import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { audit_logs } from '@prisma/client';
import { AuditRepository, type AuditLogFilters } from './audit.repository';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  DEFAULT_AUDIT_WINDOW_DAYS,
  MAX_AUDIT_WINDOW_DAYS,
} from './audit.constants';
import {
  AuditLogDto,
  AuditLogFilterDto,
  AuditSummaryDto,
  ListAuditLogsQueryDto,
  PaginatedAuditLogsDto,
} from './dto';

const MS_PER_DAY = 86_400_000;

/**
 * AuditService — the read side of the append-only audit trail.
 *
 * Nothing here writes. `audit_logs` refuses UPDATE and DELETE at the database
 * level, and the only writer is `AuditLogService.record`, called after the
 * operation it describes has committed.
 */
@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  /**
   * Resolve the query window, defaulting and validating both ends.
   *
   * A window is always applied, even when the caller names neither end. The
   * table is append-only and never pruned here, so "no window" would mean a
   * scan over a tenant's entire history on the first page — and the indexes are
   * `(business_id, …, created_at DESC)`, so a bounded window is what makes them
   * usable at all.
   */
  private resolveWindow(filters: AuditLogFilterDto): { from: Date; to: Date } {
    const to = filters.to ? new Date(filters.to) : new Date();
    if (Number.isNaN(to.getTime())) {
      throw new BadRequestException('`to` must be an ISO 8601 timestamp');
    }

    const from = filters.from
      ? new Date(filters.from)
      : new Date(to.getTime() - DEFAULT_AUDIT_WINDOW_DAYS * MS_PER_DAY);
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException('`from` must be an ISO 8601 timestamp');
    }

    if (from > to) {
      throw new BadRequestException('`from` must not be after `to`');
    }
    if (to.getTime() - from.getTime() > MAX_AUDIT_WINDOW_DAYS * MS_PER_DAY) {
      throw new BadRequestException(
        `Window must not exceed ${MAX_AUDIT_WINDOW_DAYS} days; narrow it or page through`,
      );
    }

    return { from, to };
  }

  private toFilters(dto: AuditLogFilterDto): AuditLogFilters {
    const { from, to } = this.resolveWindow(dto);
    return {
      from,
      to,
      actions: dto.actions,
      actorType: dto.actorType,
      actorId: dto.actorId,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
    };
  }

  /** One page of audit rows, newest first. */
  async list(
    businessId: string,
    query: ListAuditLogsQueryDto,
  ): Promise<PaginatedAuditLogsDto> {
    const filters = this.toFilters(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_AUDIT_PAGE_SIZE;

    const { rows, total } = await this.repository.list(
      businessId,
      filters,
      (page - 1) * limit,
      limit,
    );

    return {
      data: rows.map((row) => this.toDto(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      window: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    };
  }

  /** One audit row. */
  async get(businessId: string, id: string): Promise<AuditLogDto> {
    const row = await this.repository.findById(businessId, id);
    if (!row) {
      // Same non-disclosure as everywhere else: "not yours" and "not real" are
      // indistinguishable to the caller.
      throw new NotFoundException('Audit log entry not found');
    }
    return this.toDto(row);
  }

  /** Aggregate counts over the same window the list would return. */
  async summary(
    businessId: string,
    query: AuditLogFilterDto,
  ): Promise<AuditSummaryDto> {
    const filters = this.toFilters(query);

    const [byAction, byActor] = await Promise.all([
      this.repository.countByAction(businessId, filters),
      this.repository.countByActor(businessId, filters),
    ]);

    return {
      total: byAction.reduce((sum, row) => sum + row.count, 0),
      window: { from: filters.from.toISOString(), to: filters.to.toISOString() },
      byAction: byAction
        .map((row) => ({ action: String(row.action), count: row.count }))
        .sort((a, b) => b.count - a.count),
      byActor: byActor.sort((a, b) => b.count - a.count),
    };
  }

  /** Every row in the window, up to the export ceiling. */
  async export(businessId: string, query: AuditLogFilterDto): Promise<AuditLogDto[]> {
    const rows = await this.repository.listAll(businessId, this.toFilters(query));
    return rows.map((row) => this.toDto(row));
  }

  /** Row → API shape. */
  private toDto(row: audit_logs): AuditLogDto {
    return {
      id: row.id,
      businessId: row.business_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      before: row.resource_before ?? null,
      after: row.resource_after ?? null,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      requestId: row.request_id,
      description: row.description,
      createdAt: row.created_at.toISOString(),
    };
  }
}
