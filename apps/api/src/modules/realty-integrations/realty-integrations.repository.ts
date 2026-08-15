import { Injectable } from '@nestjs/common';
// `RealtyEoiStatus` is a value here, not just a type: `settleEoiAsPaid` reads
// `.PAID` off it to build the conditional-update predicate.
import { Prisma, RealtyIntegrationProvider, RealtyEoiStatus } from '@prisma/client';
import type {
  realty_integration_connections,
  realty_eoi_requests,
  RealtyIntegrationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { ResourceNotFoundError } from '@gosumo/shared';

export interface UpsertConnectionData {
  status?: RealtyIntegrationStatus;
  config?: Record<string, unknown>;
  externalRef?: string | null;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateEoiData {
  businessId: string;
  leadId: string;
  unitId?: string | null;
  amount: Prisma.Decimal;
  currency?: string;
  tokenLabel?: string;
  requestedBy?: string | null;
  notes?: Prisma.InputJsonValue;
}

export interface UpdateEoiData {
  status?: RealtyEoiStatus;
  paymentLinkId?: string | null;
  paymentLinkUrl?: string | null;
  gatewayPaymentId?: string | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  sentAt?: Date | null;
  paidAt?: Date | null;
  expiresAt?: Date | null;
  rejectReason?: string | null;
  notes?: Prisma.InputJsonValue;
}

/**
 * RealtyIntegrationsRepository — all Prisma access for the outbound-integrations
 * surface: per-(business, provider) connections and EOI payment requests. Every
 * tenant query filters on business_id; soft-deleted connections are excluded by
 * default.
 */
@Injectable()
export class RealtyIntegrationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Integration connections ──────────────────

  async findConnection(
    businessId: string,
    provider: RealtyIntegrationProvider,
  ): Promise<realty_integration_connections | null> {
    return this.prisma.realty_integration_connections.findFirst({
      where: { business_id: businessId, provider, deleted_at: null },
    });
  }

  async listConnections(
    businessId: string,
  ): Promise<realty_integration_connections[]> {
    return this.prisma.realty_integration_connections.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { provider: 'asc' },
    });
  }

  /** All CONNECTED Google Sheets connections across tenants (nightly sweep). */
  async listConnectedByProvider(
    provider: RealtyIntegrationProvider,
  ): Promise<realty_integration_connections[]> {
    return this.prisma.realty_integration_connections.findMany({
      where: { provider, status: 'CONNECTED', deleted_at: null },
    });
  }

  async upsertConnection(
    businessId: string,
    provider: RealtyIntegrationProvider,
    data: UpsertConnectionData,
  ): Promise<realty_integration_connections> {
    const existing = await this.findConnection(businessId, provider);
    if (existing) {
      return this.prisma.realty_integration_connections.update({
        where: { id: existing.id, business_id: businessId },
        data: {
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.config !== undefined
            ? { config: data.config as Prisma.InputJsonValue }
            : {}),
          ...(data.externalRef !== undefined ? { external_ref: data.externalRef } : {}),
          ...(data.lastError !== undefined ? { last_error: data.lastError } : {}),
          ...(data.metadata !== undefined
            ? { metadata: data.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
    }
    return this.prisma.realty_integration_connections.create({
      data: {
        business_id: businessId,
        provider,
        status: data.status ?? 'DISCONNECTED',
        config: (data.config ?? {}) as Prisma.InputJsonValue,
        external_ref: data.externalRef ?? null,
        last_error: data.lastError ?? null,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async recordSync(
    businessId: string,
    connectionId: string,
    lastError: string | null,
    incrementPushed = 0,
  ): Promise<realty_integration_connections> {
    return this.prisma.realty_integration_connections.update({
      where: { id: connectionId, business_id: businessId },
      data: {
        last_sync_at: new Date(),
        last_error: lastError,
        status: lastError ? 'ERROR' : 'CONNECTED',
        sync_count: { increment: 1 },
        ...(incrementPushed ? { pushed_count: { increment: incrementPushed } } : {}),
      },
    });
  }

  async softDeleteConnection(
    businessId: string,
    provider: RealtyIntegrationProvider,
  ): Promise<void> {
    await this.prisma.realty_integration_connections.updateMany({
      where: { business_id: businessId, provider, deleted_at: null },
      data: { deleted_at: new Date(), status: 'DISCONNECTED' },
    });
  }

  // ── EOI requests ─────────────────────────────

  async createEoi(data: CreateEoiData): Promise<realty_eoi_requests> {
    return this.prisma.realty_eoi_requests.create({
      data: {
        business_id: data.businessId,
        lead_id: data.leadId,
        unit_id: data.unitId ?? null,
        amount: data.amount,
        currency: data.currency ?? 'INR',
        token_label: data.tokenLabel ?? 'टोकन',
        requested_by: data.requestedBy ?? null,
        notes: data.notes ?? {},
      },
    });
  }

  async findEoi(businessId: string, eoiId: string): Promise<realty_eoi_requests | null> {
    return this.prisma.realty_eoi_requests.findFirst({
      where: { id: eoiId, business_id: businessId },
    });
  }

  /** Resolve an EOI by its Razorpay payment-link id (webhook/reconciliation path). */
  async findEoiByPaymentLink(
    businessId: string,
    paymentLinkId: string,
  ): Promise<realty_eoi_requests | null> {
    return this.prisma.realty_eoi_requests.findFirst({
      where: { business_id: businessId, payment_link_id: paymentLinkId },
    });
  }

  /**
   * Resolve an EOI by payment-link id WITHOUT a businessId — used ONLY on the
   * Razorpay webhook path, where the tenant is unknown until the EOI is found.
   * The link id is a Razorpay-issued opaque token, so this cannot leak across
   * tenants in practice; the caller still re-scopes every subsequent write.
   */
  async findAnyEoiByPaymentLink(
    paymentLinkId: string,
  ): Promise<realty_eoi_requests | null> {
    return this.prisma.realty_eoi_requests.findFirst({
      where: { payment_link_id: paymentLinkId },
    });
  }

  async listEoi(
    businessId: string,
    filters: { leadId?: string; status?: RealtyEoiStatus } = {},
  ): Promise<realty_eoi_requests[]> {
    return this.prisma.realty_eoi_requests.findMany({
      where: {
        business_id: businessId,
        ...(filters.leadId ? { lead_id: filters.leadId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateEoi(
    businessId: string,
    eoiId: string,
    data: UpdateEoiData,
  ): Promise<realty_eoi_requests> {
    const d: Prisma.realty_eoi_requestsUpdateManyMutationInput = {};
    if (data.status !== undefined) d.status = data.status;
    if (data.paymentLinkId !== undefined) d.payment_link_id = data.paymentLinkId;
    if (data.paymentLinkUrl !== undefined) d.payment_link_url = data.paymentLinkUrl;
    if (data.gatewayPaymentId !== undefined) d.gateway_payment_id = data.gatewayPaymentId;
    if (data.approvedBy !== undefined) d.approved_by = data.approvedBy;
    if (data.approvedAt !== undefined) d.approved_at = data.approvedAt;
    if (data.sentAt !== undefined) d.sent_at = data.sentAt;
    if (data.paidAt !== undefined) d.paid_at = data.paidAt;
    if (data.expiresAt !== undefined) d.expires_at = data.expiresAt;
    if (data.rejectReason !== undefined) d.reject_reason = data.rejectReason;
    if (data.notes !== undefined) d.notes = data.notes;

    // Scope the write by business_id (tenant safety) via updateMany, then re-read.
    await this.prisma.realty_eoi_requests.updateMany({
      where: { id: eoiId, business_id: businessId },
      data: d,
    });
    const updated = await this.findEoi(businessId, eoiId);
    if (!updated) {
      throw new ResourceNotFoundError('EOI', eoiId, {
        context: { businessId, stage: 'after-update' },
      });
    }
    return updated;
  }

  /**
   * Claim the PAID transition for one EOI, and report whether *this* call is
   * the one that made it.
   *
   * The `status: { not: PAID }` predicate is the whole point. Two settlements
   * race routinely here — Razorpay redelivers its `payment_link.paid` webhook,
   * and the operator-facing reconcile endpoint exists precisely to be used when
   * a webhook looks slow, so the two run concurrently by design. Deciding
   * "already paid?" from a row read before the write lets both callers pass the
   * check and both do the settlement work.
   *
   * Under READ COMMITTED the loser blocks on the row lock, re-evaluates the
   * predicate once the winner commits, matches nothing, and reports
   * `claimed: false`. Exactly one caller ever gets `true`.
   */
  async settleEoiAsPaid(
    businessId: string,
    eoiId: string,
    gatewayPaymentId: string | null,
    paidAt: Date,
  ): Promise<{ eoi: realty_eoi_requests; claimed: boolean }> {
    const result = await this.prisma.realty_eoi_requests.updateMany({
      where: {
        id: eoiId,
        business_id: businessId,
        status: { not: RealtyEoiStatus.PAID },
      },
      data: {
        status: RealtyEoiStatus.PAID,
        paid_at: paidAt,
        // Only overwrite when the gateway named a payment — a reconcile that
        // could not read one must not blank the id the webhook recorded.
        ...(gatewayPaymentId ? { gateway_payment_id: gatewayPaymentId } : {}),
      },
    });

    const eoi = await this.findEoi(businessId, eoiId);
    if (!eoi) {
      throw new ResourceNotFoundError('EOI', eoiId, {
        context: { businessId, stage: 'after-settle' },
      });
    }
    return { eoi, claimed: result.count > 0 };
  }
}
