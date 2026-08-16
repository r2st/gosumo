import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@gosumo/database';
import type { clients, orders, payments } from '@prisma/client';
import { AuditLogService } from '../../common/services/audit-log.service';
import {
  ClientDataCounts,
  ClientDataRows,
  DataExportRepository,
} from './data-export.repository';
import {
  EXPORT_FORMAT_VERSION,
  MAX_EXPORT_CONVERSATIONS,
  MAX_EXPORT_MESSAGES,
  MAX_EXPORT_RECORDS_PER_SECTION,
  WITHHELD_FIELDS,
} from './data-export.constants';

/** Who asked for the export — recorded on the audit trail, never in the bundle. */
export interface ExportActor {
  teamMemberId?: string | null;
  email?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
}

/** Per-section note on whether the cap bit. */
export interface SectionMeta {
  /** Rows in this bundle. */
  included: number;
  /** Rows that exist. Larger than `included` means the cap bit. */
  total: number;
  /** True when rows were left out. */
  truncated: boolean;
}

export interface DataExportBundle {
  formatVersion: string;
  generatedAt: string;
  businessId: string;
  subject: {
    clientId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    firstSeenAt: Date;
  };
  /**
   * What was left out and why. Sits beside the data rather than in a separate
   * document, because an export is read once, by somebody under a deadline,
   * and a caveat in the docs is a caveat nobody sees.
   */
  disclosure: {
    withheldFields: readonly string[];
    /** AI decisions exist but are not included; this is how many. */
    aiDecisionsExcluded: number;
    /** True when any section hit its cap. */
    truncated: boolean;
    notes: string[];
  };
  sections: Record<string, SectionMeta>;
  data: {
    profile: Record<string, unknown>;
    channelIdentities: Array<Record<string, unknown>>;
    conversations: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    orders: Array<Record<string, unknown>>;
    payments: Array<Record<string, unknown>>;
    bookings: Array<Record<string, unknown>>;
    notifications: Array<Record<string, unknown>>;
    consents: Array<Record<string, unknown>>;
  };
}

/** The cheap pre-flight: how large an export would be, without building it. */
export interface DataExportSummary {
  clientId: string;
  name: string | null;
  counts: ClientDataCounts;
  /** Sections that would be truncated at the current caps. */
  wouldTruncate: string[];
}

/**
 * DataExportService — assembles a subject-access export for one customer.
 *
 * The endpoint exists because the obligation exists: DPDPA §11 in India, GDPR
 * Art. 15 for any tenant with EU customers, and in practice a support request
 * that currently has no answer short of somebody writing SQL. The
 * `compliance` module already answers this for a *realty lead*; a client on
 * the commerce side — with orders, payments and bookings — had no equivalent.
 *
 * Three properties matter more than completeness:
 *
 *  - **Every section is bounded**, and says so when it bit. A truncated export
 *    handed over as a complete one is a worse compliance failure than no
 *    export at all, because it looks like an answer.
 *  - **Withheld fields are declared, not omitted.** See `WITHHELD_FIELDS`.
 *  - **Every export is audited before it is returned.** This is a bulk PII
 *    disclosure; who pulled it and how much is exactly the question asked
 *    after a token leak, and it cannot be reconstructed from anything else.
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    private readonly repository: DataExportRepository,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Build the export for one client.
   *
   * `clientId` is looked up scoped to the tenant, so a UUID belonging to
   * another business is a 404 rather than a cross-tenant read — and a 404
   * rather than a 403, so the endpoint does not confirm that the id exists
   * somewhere else.
   */
  async exportClient(
    businessId: string,
    clientId: string,
    actor: ExportActor = {},
  ): Promise<DataExportBundle> {
    const client = await this.repository.findClient(businessId, clientId);
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const rows = await this.repository.collect(businessId, client);
    const bundle = this.assemble(businessId, rows);

    // Awaited, not fired and forgotten. `AuditLogService.record` never throws,
    // so this cannot fail the export; awaiting it means the trail is written
    // before the data leaves the process rather than racing it.
    await this.audit.record({
      businessId,
      actorType: actor.teamMemberId ? 'TEAM_MEMBER' : 'API',
      actorId: actor.teamMemberId ?? null,
      actorEmail: actor.email ?? null,
      action: AuditAction.EXPORT,
      resourceType: 'client_data_export',
      resourceId: clientId,
      requestId: actor.requestId ?? null,
      ipAddress: actor.ipAddress ?? null,
      // The counts, never the payload. An audit row holding the export would
      // duplicate the disclosure into an append-only table that outlives every
      // retention sweep — the one table personal data must not land in.
      after: {
        sections: bundle.sections,
        truncated: bundle.disclosure.truncated,
      },
      description: `Exported all stored data for client ${clientId}`,
    });

    this.logger.log(
      `Data export for client ${clientId}: ` +
        `${bundle.sections['messages']?.included ?? 0} message(s), ` +
        `${bundle.sections['orders']?.included ?? 0} order(s)` +
        (bundle.disclosure.truncated ? ' (truncated)' : ''),
    );

    return bundle;
  }

  /**
   * Counts only — what an export *would* contain.
   *
   * Cheap enough to call before the real thing, which is the point: it is how
   * an operator finds out that this customer has 40,000 messages before they
   * request a response containing 5,000 of them and quietly deliver a partial
   * record.
   */
  async summarize(businessId: string, clientId: string): Promise<DataExportSummary> {
    const client = await this.repository.findClient(businessId, clientId);
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const counts = await this.repository.countAll(businessId, client);
    const caps: Array<[string, number, number]> = [
      ['conversations', counts.conversations, MAX_EXPORT_CONVERSATIONS],
      ['messages', counts.messages, MAX_EXPORT_MESSAGES],
      ['orders', counts.orders, MAX_EXPORT_RECORDS_PER_SECTION],
      ['payments', counts.payments, MAX_EXPORT_RECORDS_PER_SECTION],
      ['bookings', counts.bookings, MAX_EXPORT_RECORDS_PER_SECTION],
      ['notifications', counts.notifications, MAX_EXPORT_RECORDS_PER_SECTION],
      ['consents', counts.consents, MAX_EXPORT_RECORDS_PER_SECTION],
      ['channelIdentities', counts.channelContacts, MAX_EXPORT_RECORDS_PER_SECTION],
    ];

    return {
      clientId: client.id,
      name: client.name,
      counts,
      wouldTruncate: caps.filter(([, total, cap]) => total > cap).map(([name]) => name),
    };
  }

  /**
   * Resolve the identifier a data subject actually has — their phone or email
   * — to a client id, so the caller does not need to search the contacts
   * screen first.
   */
  async resolveSubject(
    businessId: string,
    identifier: { phone?: string; email?: string },
  ): Promise<clients> {
    // Enforced here rather than in the DTO: class-validator has no
    // object-level rule, and the phantom-property workaround is satisfied by a
    // caller who sends the phantom property. An empty body must not reach the
    // repository, where "matches nothing" and "no such customer" would come
    // back as the same 404.
    if (!identifier.phone && !identifier.email) {
      throw new BadRequestException(
        'Provide either a phone or an email to identify the customer',
      );
    }

    const client = await this.repository.findClientByIdentifier(businessId, identifier);
    if (!client) {
      throw new NotFoundException('No customer found for that phone or email');
    }
    return client;
  }

  // ─────────────────────────────────────────────
  // Assembly
  // ─────────────────────────────────────────────

  private assemble(businessId: string, rows: ClientDataRows): DataExportBundle {
    const { client, counts } = rows;

    const sections: Record<string, SectionMeta> = {
      channelIdentities: this.meta(rows.channelContacts.length, counts.channelContacts),
      conversations: this.meta(rows.conversations.length, counts.conversations),
      messages: this.meta(rows.messages.length, counts.messages),
      orders: this.meta(rows.orders.length, counts.orders),
      payments: this.meta(rows.payments.length, counts.payments),
      bookings: this.meta(rows.bookings.length, counts.bookings),
      notifications: this.meta(rows.notifications.length, counts.notifications),
      consents: this.meta(rows.consents.length, counts.consents),
    };

    const truncated = Object.values(sections).some((s) => s.truncated);
    const notes: string[] = [];
    if (truncated) {
      notes.push(
        'One or more sections reached their export limit. The "total" field on each ' +
          'section gives the true count; the most recent records were kept.',
      );
    }
    if (counts.aiDecisions > 0) {
      notes.push(
        'AI decision records are counted but not included: they are the business’s ' +
          'own inferences and quote internal policy. They can be produced on request.',
      );
    }

    return {
      formatVersion: EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      businessId,
      subject: {
        clientId: client.id,
        name: client.name,
        email: client.email,
        phone: client.phone,
        firstSeenAt: client.first_seen_at,
      },
      disclosure: {
        withheldFields: WITHHELD_FIELDS,
        aiDecisionsExcluded: counts.aiDecisions,
        truncated,
        notes,
      },
      sections,
      data: {
        profile: this.profileOf(client),
        channelIdentities: rows.channelContacts.map((c) => ({
          channel: c.channel,
          externalId: c.external_id,
          displayName: c.display_name,
          isOptedIn: c.is_opted_in,
          firstSeenAt: c.first_seen_at,
          lastSeenAt: c.last_seen_at,
        })),
        conversations: rows.conversations.map((c) => ({
          id: c.id,
          channel: c.channel,
          status: c.status,
          subject: c.subject,
          tags: c.tags,
          messageCount: c.message_count,
          csatScore: c.csat_score,
          firstMessageAt: c.first_message_at,
          lastMessageAt: c.last_message_at,
          resolvedAt: c.resolved_at,
          createdAt: c.created_at,
          // `metadata` is deliberately absent: it carries the team's internal
          // note about this customer. See WITHHELD_FIELDS.
        })),
        messages: rows.messages.map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          sequence: m.sequence,
          direction: m.direction,
          type: m.type,
          status: m.status,
          senderType: m.sender_type,
          content: m.content,
          textContent: m.text_content,
          isAiGenerated: m.is_ai_generated,
          reactions: m.reactions,
          sentAt: m.sent_at,
          deliveredAt: m.delivered_at,
          readAt: m.read_at,
          createdAt: m.created_at,
        })),
        orders: rows.orders.map((o) => this.orderOf(o)),
        payments: rows.payments.map((p) => this.paymentOf(p)),
        bookings: rows.bookings.map((b) => ({
          id: b.id,
          status: b.status,
          startAt: b.start_at,
          endAt: b.end_at,
          timezone: b.timezone,
          durationMinutes: b.duration_minutes,
          locationType: b.location_type,
          locationAddress: b.location_address,
          price: b.price,
          cancelledAt: b.cancelled_at,
          cancellationReason: b.cancellation_reason,
          cancelledBy: b.cancelled_by,
          createdAt: b.created_at,
        })),
        notifications: rows.notifications.map((n) => ({
          id: n.id,
          channel: n.channel,
          category: n.category,
          status: n.status,
          eventType: n.event_type,
          recipient: n.recipient,
          subject: n.subject,
          content: n.content,
          createdAt: n.created_at,
        })),
        consents: rows.consents.map((c) => ({
          type: c.consent_type,
          channel: c.channel,
          source: c.source,
          grantedAt: c.granted_at,
          revokedAt: c.revoked_at,
        })),
      },
    };
  }

  private meta(included: number, total: number): SectionMeta {
    return { included, total, truncated: included < total };
  }

  private profileOf(client: clients): Record<string, unknown> {
    return {
      name: client.name,
      email: client.email,
      phone: client.phone,
      tags: client.tags,
      // The AI-built enrichment profile and the opt-out map are both the
      // subject's own data — one is derived from what they said, the other is
      // a preference they set — so both are included.
      profile: client.profile,
      optOuts: client.opt_outs,
      totalOrders: client.total_orders,
      totalSpent: client.total_spent,
      lastInteractionAt: client.last_interaction_at,
      firstSeenAt: client.first_seen_at,
      // Deliberately absent: ltv_score, churn_risk and engagement_score are
      // scores the business assigns *to* the customer, in the same category as
      // the AI decisions, and disclosing a churn-risk figure to the person it
      // describes is a decision for the business to make, not a default.
    };
  }

  private orderOf(order: orders): Record<string, unknown> {
    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      lineItems: order.line_items,
      subtotal: order.subtotal,
      discountAmount: order.discount_amount,
      taxAmount: order.tax_amount,
      shippingFee: order.shipping_fee,
      total: order.total,
      currency: order.currency,
      customerNote: order.customer_note,
      placedAt: order.placed_at,
      confirmedAt: order.confirmed_at,
      deliveredAt: order.delivered_at,
      cancelledAt: order.cancelled_at,
      cancellationReason: order.cancellation_reason,
      returnedAt: order.returned_at,
      // `internal_note` withheld — see WITHHELD_FIELDS.
    };
  }

  private paymentOf(payment: payments): Record<string, unknown> {
    return {
      id: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      method: payment.method,
      gateway: payment.gateway,
      amount: payment.amount,
      currency: payment.currency,
      // The gateway's own payment id is the reference the customer needs to
      // raise a dispute with their bank, so it stays. The signature and the
      // raw gateway body do not — see WITHHELD_FIELDS.
      gatewayPaymentId: payment.gateway_payment_id,
      initiatedAt: payment.initiated_at,
      capturedAt: payment.captured_at,
      failedAt: payment.failed_at,
      failureReason: payment.failure_reason,
      createdAt: payment.created_at,
    };
  }
}
