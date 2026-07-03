import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

/** Who performed the realty operation being audited. */
export type RealtyActorType = 'TEAM_MEMBER' | 'AI' | 'SYSTEM' | 'API';

/** A single realty state-changing operation to record on `audit_logs`. */
export interface RealtyOperationAudit {
  businessId: string;
  actorType: RealtyActorType;
  actorId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  /** e.g. "realty_lead" | "realty_unit" | "realty_dead_letter". */
  resourceType: string;
  resourceId?: string | null;
  /** Snapshot before the change (optional — not always available). */
  before?: unknown;
  /** Snapshot after the change (optional). */
  after?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  description?: string | null;
}

/**
 * RealtyOperationsAuditService — the append-only trail for **every** realty
 * state-changing operation (blueprint §21: "Auditability: append-only
 * audit_logs"). Phase-7 counterpart to the AI-decision-only
 * `RealtyAuditService`: this one covers lead/inventory/site-visit/cadence/broker
 * mutations, driven automatically by {@link RealtyAuditInterceptor} and callable
 * directly by services that want a richer before/after snapshot.
 *
 * `audit_logs` is enforced append-only at the DB level (`audit_logs_no_update` /
 * `audit_logs_no_delete`) — we only ever INSERT. Logging is best-effort: a
 * failure here must never block or roll back the operation being audited.
 */
@Injectable()
export class RealtyOperationsAuditService {
  private readonly logger = new Logger(RealtyOperationsAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Record one realty operation. Never throws. */
  async record(entry: RealtyOperationAudit): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          business_id: entry.businessId,
          actor_type: entry.actorType,
          actor_id: entry.actorId ?? null,
          actor_email: entry.actorEmail ?? null,
          action: entry.action,
          resource_type: entry.resourceType,
          resource_id: this.asUuidOrNull(entry.resourceId),
          resource_before: this.asJson(entry.before),
          resource_after: this.asJson(entry.after),
          request_id: entry.requestId ?? null,
          ip_address: entry.ipAddress ?? null,
          user_agent: entry.userAgent ?? null,
          description: entry.description ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write realty audit log (${entry.resourceType} ${entry.action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Map an HTTP verb to the closest audit action. */
  static actionForMethod(method: string): AuditAction {
    switch (method.toUpperCase()) {
      case 'POST':
        return AuditAction.CREATE;
      case 'PUT':
      case 'PATCH':
        return AuditAction.UPDATE;
      case 'DELETE':
        return AuditAction.DELETE;
      default:
        return AuditAction.UPDATE;
    }
  }

  /** `resource_id` is a `@db.Uuid` — only persist genuine UUIDs, else null. */
  private asUuidOrNull(value?: string | null): string | null {
    if (!value) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  }

  private asJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    // Round-trip through JSON so Date/Decimal and cyclic-free structures persist.
    try {
      return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    } catch {
      return undefined;
    }
  }
}
