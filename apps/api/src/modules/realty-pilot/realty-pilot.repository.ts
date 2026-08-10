import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  realty_migration_runs,
  realty_autonomy_events,
  realty_no_ship_incidents,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreateMigrationRunData {
  businessId: string;
  kind: realty_migration_runs['kind'];
  status: realty_migration_runs['status'];
  dryRun: boolean;
  totalRows: number;
  createdCount: number;
  mergedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: Prisma.InputJsonValue;
  summary: Prisma.InputJsonValue;
  createdBy?: string | null;
}

export interface CreateAutonomyEventData {
  businessId: string;
  direction: realty_autonomy_events['direction'];
  fromLevel: realty_autonomy_events['from_level'];
  toLevel: realty_autonomy_events['to_level'];
  fromThreshold: number;
  toThreshold: number;
  evidence: Prisma.InputJsonValue;
  reason: string;
  actorType: realty_autonomy_events['actor_type'];
  actorId?: string | null;
}

export interface CreateNoShipData {
  businessId: string;
  kind: realty_no_ship_incidents['kind'];
  leadId?: string | null;
  conversationId?: string | null;
  detail: string;
  source: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * RealtyPilotRepository — all Prisma access for the Phase-8 tables: migration
 * runs, the append-only autonomy-event ledger, and the append-only no-ship
 * incident ledger. Every query is scoped by business_id; migration runs are
 * soft-delete aware. The two ledgers are insert-only (DB rules block mutation).
 */
@Injectable()
export class RealtyPilotRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Migration runs ───────────────────────────

  async createMigrationRun(data: CreateMigrationRunData): Promise<realty_migration_runs> {
    return this.prisma.realty_migration_runs.create({
      data: {
        business_id: data.businessId,
        kind: data.kind,
        status: data.status,
        dry_run: data.dryRun,
        total_rows: data.totalRows,
        created_count: data.createdCount,
        merged_count: data.mergedCount,
        skipped_count: data.skippedCount,
        error_count: data.errorCount,
        errors: data.errors,
        summary: data.summary,
        created_by: data.createdBy ?? null,
      },
    });
  }

  async findMigrationRun(businessId: string, id: string): Promise<realty_migration_runs | null> {
    return this.prisma.realty_migration_runs.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async listMigrationRuns(
    businessId: string,
    filters: { kind?: string } = {},
  ): Promise<realty_migration_runs[]> {
    const where: Prisma.realty_migration_runsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.kind) where.kind = filters.kind as realty_migration_runs['kind'];
    return this.prisma.realty_migration_runs.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  // ── Autonomy-event ledger (append-only) ──────

  async createAutonomyEvent(data: CreateAutonomyEventData): Promise<realty_autonomy_events> {
    return this.prisma.realty_autonomy_events.create({
      data: {
        business_id: data.businessId,
        direction: data.direction,
        from_level: data.fromLevel,
        to_level: data.toLevel,
        from_threshold: data.fromThreshold,
        to_threshold: data.toThreshold,
        evidence: data.evidence,
        reason: data.reason,
        actor_type: data.actorType,
        actor_id: data.actorId ?? null,
      },
    });
  }

  async listAutonomyEvents(businessId: string, limit = 100): Promise<realty_autonomy_events[]> {
    return this.prisma.realty_autonomy_events.findMany({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  // ── No-ship incident ledger (append-only) ────

  async createNoShipIncident(data: CreateNoShipData): Promise<realty_no_ship_incidents> {
    return this.prisma.realty_no_ship_incidents.create({
      data: {
        business_id: data.businessId,
        kind: data.kind,
        lead_id: data.leadId ?? null,
        conversation_id: data.conversationId ?? null,
        detail: data.detail,
        source: data.source,
        metadata: data.metadata ?? {},
      },
    });
  }

  async countNoShipIncidents(businessId: string, since?: Date): Promise<number> {
    return this.prisma.realty_no_ship_incidents.count({
      where: { business_id: businessId, ...(since ? { created_at: { gte: since } } : {}) },
    });
  }

  /** No-ship counts grouped by kind (for the itemized launch-gate checks). */
  async countNoShipByKind(businessId: string, since?: Date): Promise<Record<string, number>> {
    const rows = await this.prisma.realty_no_ship_incidents.groupBy({
      by: ['kind'],
      where: { business_id: businessId, ...(since ? { created_at: { gte: since } } : {}) },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r._count._all;
    return out;
  }

  async listNoShipIncidents(businessId: string, limit = 100): Promise<realty_no_ship_incidents[]> {
    return this.prisma.realty_no_ship_incidents.findMany({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }
}
