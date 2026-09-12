import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

/** Who performed the operation being audited. */
export type AuditActorType = 'TEAM_MEMBER' | 'AI' | 'SYSTEM' | 'API';

/**
 * The team member a privileged operation is attributed to. Controllers build
 * this from the JWT and hand it down; a service that receives none records the
 * operation as SYSTEM rather than as an anonymous team member.
 */
export interface AuditActor {
  id: string;
  email?: string | null;
}

/** One state-changing operation to record on `audit_logs`. */
export interface AuditLogEntry {
  businessId: string;
  actorType: AuditActorType;
  /** The acting team member, when a human did this. */
  actorId?: string | null;
  /** Email snapshotted at the time of the action — actors can be removed later. */
  actorEmail?: string | null;
  action: AuditAction;
  /** e.g. "team_member" | "business_settings". */
  resourceType: string;
  resourceId?: string | null;
  /** Snapshot before the change. Together with `after` this is the diff. */
  before?: unknown;
  /** Snapshot after the change. */
  after?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  description?: string | null;
}

/**
 * AuditLogService — the append-only trail for privileged operations that are
 * not attributable from the data they change.
 *
 * Most tables carry enough of their own history to answer "what happened":
 * messages are append-only, orders keep their status transitions, conversations
 * record who resolved them. Authority changes do not. `team_members.role` is a
 * single mutable column, so promoting someone to OWNER — which grants billing,
 * data export, and the ability to grant OWNER to anyone else — overwrites the
 * only evidence that they used to be a STAFF member, and leaves nothing at all
 * saying who did it. `audit_logs` exists precisely for those, and until now the
 * only writers were the realty routes, AI decisions and DPDPA compliance.
 *
 * Two rules follow from `audit_logs` being append-only (enforced in the database
 * by `audit_logs_no_update` / `audit_logs_no_delete`):
 *
 *  - **INSERT only.** Never correct a row; write another one.
 *  - **Best-effort.** A failure here is logged, never thrown. An audit write
 *    that could fail the operation it describes would make the trail a new way
 *    for the product to break, and callers would learn to work around it.
 *
 * Record *after* the operation commits. A row describing a change that then
 * rolled back is worse than a missing one, because it reads as authoritative.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Record one operation. Never throws. */
  async record(entry: AuditLogEntry): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          business_id: entry.businessId,
          actor_type: entry.actorType,
          actor_id: this.asUuidOrNull(entry.actorId),
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
        `Failed to write audit log (${entry.resourceType} ${entry.action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * `actor_id` and `resource_id` are `@db.Uuid` columns with FKs behind them.
   * A non-UUID string would make the INSERT throw, which the catch above would
   * swallow — losing the whole row rather than one field. Null out the id and
   * keep the record.
   */
  private asUuidOrNull(value?: string | null): string | null {
    if (!value) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  }

  /** Round-trip through JSON so Date/Decimal values persist as scalars. */
  private asJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    try {
      return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    } catch {
      return undefined;
    }
  }
}
