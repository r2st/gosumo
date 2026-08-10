import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma.service';

/** The realty AI decision to record. */
export interface RealtyAuditEntry {
  businessId: string;
  leadId?: string | null;
  conversationId?: string | null;
  /** AUTO | DRAFT | GUIDED | ESCALATE. */
  routeMode: string;
  intent: string;
  confidence: number;
  /** The text the AI sent or drafted. */
  responseText?: string | null;
  /** Guardrail codes that fired (empty when clean). */
  violations?: string[];
  /** Structured actions the AI proposed/executed. */
  actions?: unknown[];
  correlationId?: string;
}

/**
 * RealtyAuditService — writes an append-only `audit_logs` row for every
 * autonomous (or drafted/escalated) realty AI decision (blueprint §16.3, §21:
 * "every autonomous action → append-only audit_logs").
 *
 * `audit_logs` is enforced append-only at the DB level (rules
 * `audit_logs_no_update`/`audit_logs_no_delete`) — we only ever INSERT.
 * Logging is best-effort: a failure here must never block the customer reply.
 */
@Injectable()
export class RealtyAuditService {
  private readonly logger = new Logger(RealtyAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Record a realty AI decision. Never throws. */
  async record(entry: RealtyAuditEntry): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          business_id: entry.businessId,
          actor_type: 'AI',
          action: this.actionFor(entry.routeMode),
          resource_type: 'realty_lead',
          resource_id: entry.leadId ?? null,
          resource_after: this.snapshot(entry),
          request_id: entry.correlationId ?? null,
          description: `Realty AI ${entry.routeMode} · ${entry.intent} · confidence ${entry.confidence}${
            entry.violations && entry.violations.length ? ` · guardrails: ${entry.violations.join(', ')}` : ''
          }`,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write realty audit log for lead ${entry.leadId ?? '?'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Map the routing mode to the closest audit action verb. */
  private actionFor(routeMode: string): AuditAction {
    switch (routeMode) {
      case 'ESCALATE':
        return AuditAction.ESCALATE;
      case 'AUTO':
        return AuditAction.CREATE; // an autonomous outbound message was created/sent
      default:
        return AuditAction.UPDATE; // DRAFT / GUIDED — a draft was prepared for review
    }
  }

  private snapshot(entry: RealtyAuditEntry): Prisma.InputJsonValue {
    return {
      routeMode: entry.routeMode,
      intent: entry.intent,
      confidence: entry.confidence,
      responseText: entry.responseText ?? null,
      violations: entry.violations ?? [],
      actions: (entry.actions ?? []) as Prisma.InputJsonValue,
      conversationId: entry.conversationId ?? null,
    };
  }
}
