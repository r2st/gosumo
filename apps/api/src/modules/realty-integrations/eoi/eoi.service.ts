import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, RealtyEoiStatus } from '@prisma/client';
import type { realty_eoi_requests } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  LeadStage,
  ConflictError,
} from '@gosumo/shared';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { RazorpayService } from '../../payment/razorpay.service';
import { RealtyIntegrationsRepository } from '../realty-integrations.repository';
import { RequestEoiDto } from '../dto';
import type {
  RealtyEoiRequestedEvent,
  RealtyEoiApprovedEvent,
  RealtyEoiRejectedEvent,
  RealtyEoiPaidEvent,
  RealtyEoiStatusChangedEvent,
} from '../realty-integrations.events';

export interface EoiResponseDto {
  id: string;
  businessId: string;
  leadId: string;
  unitId: string | null;
  amountPaise: number;
  currency: string;
  tokenLabel: string;
  status: RealtyEoiStatus;
  paymentLinkId: string | null;
  paymentLinkUrl: string | null;
  gatewayPaymentId: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  paidAt: Date | null;
  expiresAt: Date | null;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal Razorpay `payment_link.paid` webhook shape (subset we read). */
interface RazorpayEoiWebhook {
  event: string;
  payload: {
    payment_link?: { entity: { id: string; status: string; amount_paid?: number } };
    payment?: { entity: { id: string; notes?: Record<string, string> } };
  };
}

function decimalToPaise(d: Prisma.Decimal): number {
  return new Prisma.Decimal(d).mul(100).round().toNumber();
}

/** Default payment-link validity: 48 hours. */
const DEFAULT_EXPIRY_MINUTES = 2880;
/** The stage a lead advances to once its EOI (token) is paid. */
const PAID_LEAD_STAGE = LeadStage.NEGOTIATING;

/**
 * EoiService — Expression-of-Interest (बुकिंग टोकन) payments for qualified
 * leads. A token request is created PENDING_APPROVAL; a broker must APPROVE it
 * before a Razorpay payment link is generated and sent (approval gate). Payment
 * (via webhook or reconciliation) marks the EOI PAID and advances the lead's
 * stage. Amounts are stored in rupees (Decimal); paise at the API boundary.
 */
@Injectable()
export class EoiService {
  private readonly logger = new Logger(EoiService.name);

  constructor(
    private readonly repository: RealtyIntegrationsRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly razorpay: RazorpayService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Request (no link yet — awaits broker approval) ──

  async requestEoi(
    businessId: string,
    dto: RequestEoiDto,
    requestedBy?: string,
  ): Promise<EoiResponseDto> {
    // Confirm the lead exists (and is this tenant's) before creating a token.
    await this.leadsService.getLead(businessId, dto.leadId);

    const eoi = await this.repository.createEoi({
      businessId,
      leadId: dto.leadId,
      unitId: dto.unitId ?? null,
      amount: new Prisma.Decimal(dto.amountPaise).div(100),
      tokenLabel: dto.tokenLabel,
      requestedBy: requestedBy ?? null,
      notes: dto.note ? ({ requestNote: dto.note } as Prisma.InputJsonValue) : undefined,
    });

    this.emit<RealtyEoiRequestedEvent>('realty.eoi.requested', {
      ...this.base(businessId),
      type: 'realty.eoi.requested',
      eoiId: eoi.id,
      leadId: eoi.lead_id,
      amountPaise: dto.amountPaise,
    });
    this.logger.log(
      `EOI ${eoi.id} requested for lead ${dto.leadId} (₹${(dto.amountPaise / 100).toFixed(2)}) — awaiting broker approval`,
    );
    return this.map(eoi);
  }

  // ── Broker approval gate → generate + send link ──

  /**
   * Broker approves the token: generate the Razorpay payment link and mark the
   * EOI LINK_SENT. Only a PENDING_APPROVAL request can be approved. The link's
   * notes carry {eoiId, leadId, businessId} so the paid-webhook can correlate.
   */
  async approveEoi(
    businessId: string,
    eoiId: string,
    approvedBy: string,
    expiryMinutes = DEFAULT_EXPIRY_MINUTES,
  ): Promise<EoiResponseDto> {
    const eoi = await this.mustFind(businessId, eoiId);
    if (eoi.status !== RealtyEoiStatus.PENDING_APPROVAL) {
      throw new ConflictError(
        `EOI ${eoiId} is ${eoi.status}, only a PENDING_APPROVAL request can be approved`,
        { context: { businessId, eoiId, status: eoi.status, action: 'approve' } },
      );
    }

    const lead = await this.leadsService.getLead(businessId, eoi.lead_id);
    const amountPaise = decimalToPaise(eoi.amount);
    const expireBy = Math.floor(Date.now() / 1000) + expiryMinutes * 60;

    const link = await this.razorpay.createPaymentLink({
      amountPaise,
      currency: eoi.currency,
      description: `${eoi.token_label} — ${lead.name ?? lead.whatsappPhone}`,
      customer: {
        name: lead.name ?? undefined,
        email: lead.email ?? undefined,
        phone: lead.whatsappPhone,
      },
      expireBy,
      referenceId: eoi.id,
      notes: {
        eoiId: eoi.id,
        leadId: eoi.lead_id,
        businessId,
        kind: 'realty_eoi',
      },
    });

    const now = new Date();
    const updated = await this.repository.updateEoi(businessId, eoiId, {
      status: RealtyEoiStatus.LINK_SENT,
      paymentLinkId: link.id,
      paymentLinkUrl: link.shortUrl,
      approvedBy,
      approvedAt: now,
      sentAt: now,
      expiresAt: new Date(expireBy * 1000),
    });

    this.emit<RealtyEoiApprovedEvent>('realty.eoi.approved', {
      ...this.base(businessId),
      type: 'realty.eoi.approved',
      eoiId,
      leadId: eoi.lead_id,
      paymentLinkId: link.id,
      paymentLinkUrl: link.shortUrl,
    });
    this.emitStatusChange(businessId, updated, eoi.status);
    this.logger.log(`EOI ${eoiId} approved by ${approvedBy}; link ${link.id} sent`);
    return this.map(updated);
  }

  async rejectEoi(
    businessId: string,
    eoiId: string,
    rejectedBy: string,
    reason: string,
  ): Promise<EoiResponseDto> {
    const eoi = await this.mustFind(businessId, eoiId);
    if (eoi.status !== RealtyEoiStatus.PENDING_APPROVAL) {
      throw new ConflictError(
        `EOI ${eoiId} is ${eoi.status}, only a PENDING_APPROVAL request can be rejected`,
        { context: { businessId, eoiId, status: eoi.status, action: 'reject' } },
      );
    }
    const updated = await this.repository.updateEoi(businessId, eoiId, {
      status: RealtyEoiStatus.REJECTED,
      approvedBy: rejectedBy,
      approvedAt: new Date(),
      rejectReason: reason,
    });
    this.emit<RealtyEoiRejectedEvent>('realty.eoi.rejected', {
      ...this.base(businessId),
      type: 'realty.eoi.rejected',
      eoiId,
      leadId: eoi.lead_id,
      reason,
    });
    this.emitStatusChange(businessId, updated, eoi.status);
    return this.map(updated);
  }

  // ── Payment tracking ─────────────────────────

  /**
   * Handle a Razorpay webhook (verify signature FIRST — root rule #3). Acts only
   * on `payment_link.paid` for links tagged `kind=realty_eoi`. Idempotent: a
   * duplicate delivery on an already-PAID EOI is a no-op.
   */
  async handleRazorpayWebhook(
    rawBody: string | Buffer,
    signature: string,
  ): Promise<{ handled: boolean }> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw new BadRequestException('Invalid Razorpay webhook signature');
    }
    const payloadStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const event = JSON.parse(payloadStr) as RazorpayEoiWebhook;
    if (event.event !== 'payment_link.paid') {
      return { handled: false };
    }

    const linkEntity = event.payload.payment_link?.entity;
    const paymentEntity = event.payload.payment?.entity;
    if (!linkEntity) {
      this.logger.warn('payment_link.paid webhook missing payment_link entity');
      return { handled: false };
    }
    const notes = paymentEntity?.notes ?? {};
    if (notes.kind && notes.kind !== 'realty_eoi') {
      return { handled: false }; // some other payment link, not ours
    }

    // Correlate: prefer notes (tenant-safe), fall back to the link id.
    const businessId = notes.businessId;
    const eoi = businessId
      ? await this.repository.findEoiByPaymentLink(businessId, linkEntity.id)
      : await this.repository.findAnyEoiByPaymentLink(linkEntity.id);
    if (!eoi) {
      this.logger.warn(`No EOI found for paid payment link ${linkEntity.id}`);
      return { handled: false };
    }

    await this.markPaid(eoi.business_id, eoi, paymentEntity?.id);
    return { handled: true };
  }

  /**
   * Poll Razorpay for a link's status and settle the EOI if it has been paid.
   * The safety net for a missed webhook (mirrors the payment module's reconcile).
   */
  async reconcileEoi(businessId: string, eoiId: string): Promise<EoiResponseDto> {
    const eoi = await this.mustFind(businessId, eoiId);
    if (eoi.status === RealtyEoiStatus.PAID) return this.map(eoi);
    if (!eoi.payment_link_id) {
      throw new BadRequestException('EOI has no payment link to reconcile');
    }
    const status = await this.razorpay.fetchPaymentLinkStatus(eoi.payment_link_id);
    if (status.status === 'paid') {
      const updated = await this.markPaid(businessId, eoi, status.paymentId);
      return this.map(updated);
    }
    return this.map(eoi);
  }

  /**
   * Settle an EOI as PAID and advance its lead's stage. Idempotent under
   * concurrency, which is the only kind that matters here.
   *
   * Two settlements race routinely: Razorpay redelivers `payment_link.paid`
   * whenever our response is slow, and `POST /:id/reconcile` exists to be used
   * exactly when a webhook looks like it went missing — so an operator clicking
   * it while the webhook is in flight is the designed-for case, not an exotic
   * one. This used to guard on `eoi.status` from a row read *before* the write,
   * so both callers passed the check, both wrote PAID, and both did everything
   * below it: the lead was advanced twice and `realty.eoi.paid` was emitted
   * twice, double-counting a booking that happened once.
   *
   * The claim is now made in the database, and only the caller that wins it
   * does the rest.
   */
  private async markPaid(
    businessId: string,
    eoi: realty_eoi_requests,
    gatewayPaymentId?: string,
  ): Promise<realty_eoi_requests> {
    const { eoi: updated, claimed } = await this.repository.settleEoiAsPaid(
      businessId,
      eoi.id,
      gatewayPaymentId ?? null,
      new Date(),
    );

    if (!claimed) {
      this.logger.log(
        `EOI ${eoi.id} was already settled — skipping duplicate stage advance and event`,
      );
      return updated;
    }

    // Advance the lead — a paid token is a strong buying signal.
    try {
      await this.leadsService.transitionStage(businessId, eoi.lead_id, {
        stage: PAID_LEAD_STAGE,
      });
    } catch (err) {
      this.logger.error(
        `EOI ${eoi.id} paid but lead ${eoi.lead_id} stage transition failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.emit<RealtyEoiPaidEvent>('realty.eoi.paid', {
      ...this.base(businessId),
      type: 'realty.eoi.paid',
      eoiId: eoi.id,
      leadId: eoi.lead_id,
      amountPaise: decimalToPaise(eoi.amount),
      gatewayPaymentId,
    });
    this.emitStatusChange(businessId, updated, eoi.status);
    this.logger.log(`EOI ${eoi.id} PAID; lead ${eoi.lead_id} → ${PAID_LEAD_STAGE}`);
    return updated;
  }

  // ── Reads ────────────────────────────────────

  async getEoi(businessId: string, eoiId: string): Promise<EoiResponseDto> {
    return this.map(await this.mustFind(businessId, eoiId));
  }

  async listEoi(
    businessId: string,
    filters: { leadId?: string; status?: RealtyEoiStatus } = {},
  ): Promise<EoiResponseDto[]> {
    const rows = await this.repository.listEoi(businessId, filters);
    return rows.map((r) => this.map(r));
  }

  // ── Helpers ──────────────────────────────────

  private async mustFind(businessId: string, eoiId: string): Promise<realty_eoi_requests> {
    const eoi = await this.repository.findEoi(businessId, eoiId);
    if (!eoi) throw new NotFoundException(`EOI ${eoiId} not found`);
    return eoi;
  }

  private emitStatusChange(
    businessId: string,
    eoi: realty_eoi_requests,
    fromStatus: RealtyEoiStatus,
  ): void {
    if (fromStatus === eoi.status) return;
    this.emit<RealtyEoiStatusChangedEvent>('realty.eoi.status_changed', {
      ...this.base(businessId),
      type: 'realty.eoi.status_changed',
      eoiId: eoi.id,
      leadId: eoi.lead_id,
      fromStatus,
      toStatus: eoi.status,
    });
  }

  private base(businessId: string) {
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

  private map(eoi: realty_eoi_requests): EoiResponseDto {
    return {
      id: eoi.id,
      businessId: eoi.business_id,
      leadId: eoi.lead_id,
      unitId: eoi.unit_id,
      amountPaise: decimalToPaise(eoi.amount),
      currency: eoi.currency,
      tokenLabel: eoi.token_label,
      status: eoi.status,
      paymentLinkId: eoi.payment_link_id,
      paymentLinkUrl: eoi.payment_link_url,
      gatewayPaymentId: eoi.gateway_payment_id,
      approvedBy: eoi.approved_by,
      approvedAt: eoi.approved_at,
      sentAt: eoi.sent_at,
      paidAt: eoi.paid_at,
      expiresAt: eoi.expires_at,
      rejectReason: eoi.reject_reason,
      createdAt: eoi.created_at,
      updatedAt: eoi.updated_at,
    };
  }
}
