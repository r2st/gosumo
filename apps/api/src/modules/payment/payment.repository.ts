import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { PaymentStatus, RefundStatus, currencyToPaise, ResourceNotFoundError } from '@gosumo/shared';
import { Prisma } from '@prisma/client';
import type { payments, refunds, invoices } from '@prisma/client';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreatePaymentData {
  businessId: string;
  orderId?: string;
  clientId: string;
  /** Amount in rupees (Decimal(14,2)) */
  amountRupees: number;
  currency?: string;
  gateway: string;
  paymentLinkUrl?: string;
  paymentLinkId?: string;
  paymentLinkExpiresAt?: Date;
  gatewayOrderId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRefundData {
  businessId: string;
  paymentId: string;
  orderId?: string;
  /** Amount in rupees (Decimal(14,2)) */
  amountRupees: number;
  currency?: string;
  reason?: string;
  requiresApproval?: boolean;
  gatewayRefundId?: string;
  gatewayResponse?: Record<string, unknown>;
}

/**
 * Outcome of an atomic refund reservation.
 *
 * The amounts are the ones observed while the payment row was locked, so a
 * refusal can explain itself with the numbers that actually caused it rather
 * than with a second, unsynchronized read.
 */
export interface ReserveRefundResult {
  /** The reserved row, or null when the balance did not cover the request. */
  refund: refunds | null;
  reserved: boolean;
  originalAmountPaise: number;
  committedPaise: number;
  refundablePaise: number;
}

export interface PaymentListFilters {
  status?: string;
  orderId?: string;
  clientId?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedPayments {
  data: payments[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedRefunds {
  data: refunds[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaymentSummaryResult {
  paidRupees: number;
  pendingRupees: number;
  refundedRupees: number;
}

export interface InvoiceLineItemData {
  description: string;
  quantity: number;
  /** Unit price in minor units (e.g. paise) */
  unitAmountMinor: number;
  /** Line total in minor units (quantity × unitAmountMinor) */
  amountMinor: number;
}

export interface CreateInvoiceData {
  businessId: string;
  orderId?: string;
  clientId: string;
  paymentId?: string;
  invoiceNumber: string;
  currency?: string;
  /** All amounts in the currency major unit (e.g. rupees) */
  subtotal: number;
  taxAmount?: number;
  discountAmount?: number;
  total: number;
  lineItems: InvoiceLineItemData[];
  notes?: string;
  dueAt?: Date;
}

export interface InvoiceListFilters {
  status?: string;
  orderId?: string;
  clientId?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedInvoices {
  data: invoices[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * PaymentRepository — all Prisma queries for payments and refunds.
 *
 * Every query includes businessId scoping as per multi-tenant rules.
 */
@Injectable()
export class PaymentRepository {
  private readonly logger = new Logger(PaymentRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────
  // Payments
  // ─────────────────────────────────────────────

  /**
   * Create a new payment record.
   */
  async createPayment(data: CreatePaymentData): Promise<payments> {
    return this.prisma.payments.create({
      data: {
        business_id: data.businessId,
        order_id: data.orderId ?? null,
        client_id: data.clientId,
        status: 'PENDING',
        gateway: data.gateway as Prisma.EnumPaymentGatewayFieldUpdateOperationsInput['set'],
        amount: new Prisma.Decimal(data.amountRupees),
        currency: data.currency ?? 'INR',
        payment_link_url: data.paymentLinkUrl ?? null,
        payment_link_id: data.paymentLinkId ?? null,
        payment_link_expires_at: data.paymentLinkExpiresAt ?? null,
        gateway_order_id: data.gatewayOrderId ?? null,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
        gateway_response: Prisma.JsonNull,
      },
    });
  }

  /**
   * Find a payment by ID within a business scope.
   */
  async getPayment(businessId: string, paymentId: string): Promise<payments | null> {
    return this.prisma.payments.findFirst({
      where: {
        id: paymentId,
        business_id: businessId,
      },
    });
  }

  /**
   * List payments for a business with optional filters, paginated.
   */
  async listPayments(
    businessId: string,
    filters: PaymentListFilters,
  ): Promise<PaginatedPayments> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      business_id: businessId,
    };

    if (filters.status) {
      where['status'] = filters.status;
    }
    if (filters.orderId) {
      where['order_id'] = filters.orderId;
    }
    if (filters.clientId) {
      where['client_id'] = filters.clientId;
    }

    const [data, total] = await Promise.all([
      this.prisma.payments.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payments.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update a payment's status and related fields.
   */
  async updatePaymentStatus(
    businessId: string,
    paymentId: string,
    data: {
      status: string;
      method?: string | null;
      gatewayPaymentId?: string | null;
      gatewaySignature?: string | null;
      gatewayResponse?: Record<string, unknown>;
      initiatedAt?: Date | null;
      capturedAt?: Date | null;
      failedAt?: Date | null;
      failureReason?: string | null;
    },
  ): Promise<payments> {
    // Verify business scoping first
    const existing = await this.prisma.payments.findFirst({
      where: {
        id: paymentId,
        business_id: businessId,
      },
    });

    if (!existing) {
      throw new ResourceNotFoundError('Payment', paymentId, {
        context: { businessId },
      });
    }

    const updateData: Record<string, unknown> = {
      status: data.status,
    };

    if (data.method !== undefined) {
      updateData['method'] = data.method;
    }
    if (data.gatewayPaymentId !== undefined) {
      updateData['gateway_payment_id'] = data.gatewayPaymentId;
    }
    if (data.gatewaySignature !== undefined) {
      updateData['gateway_signature'] = data.gatewaySignature;
    }
    if (data.gatewayResponse !== undefined) {
      updateData['gateway_response'] = data.gatewayResponse as Prisma.InputJsonValue;
    }
    if (data.initiatedAt !== undefined) {
      updateData['initiated_at'] = data.initiatedAt;
    }
    if (data.capturedAt !== undefined) {
      updateData['captured_at'] = data.capturedAt;
    }
    if (data.failedAt !== undefined) {
      updateData['failed_at'] = data.failedAt;
    }
    if (data.failureReason !== undefined) {
      updateData['failure_reason'] = data.failureReason;
    }

    return this.prisma.payments.update({
      where: { id: paymentId, business_id: businessId },
      data: updateData,
    });
  }

  /**
   * Claim the SUCCESS transition for one payment, and report whether *this*
   * call is the one that made it.
   *
   * Three callers settle the same payment and they overlap routinely:
   *
   *   - `payment.authorized` and `payment.captured` are separate Razorpay
   *     events sent milliseconds apart for one payment. They carry different
   *     `webhook_events` keys — `${event}_${paymentId}` — so the idempotency
   *     ledger does not collapse them, and both dispatch to the same handler.
   *   - the reconcile sweep polls the gateway and settles anything it finds
   *     paid, which is most likely to run precisely when a webhook is late.
   *
   * Deciding "already SUCCESS?" from a row read before the write lets every
   * one of them pass the check and emit `payment.success` again for money that
   * was collected once. Under READ COMMITTED the losers block on the row lock,
   * re-evaluate the predicate after the winner commits, and match nothing.
   */
  async claimPaymentSuccess(
    businessId: string,
    paymentId: string,
    data: {
      method?: string | null;
      gatewayPaymentId?: string | null;
      gatewayResponse?: Record<string, unknown>;
      capturedAt: Date;
    },
  ): Promise<{ payment: payments; claimed: boolean }> {
    const updateData: Record<string, unknown> = {
      status: PaymentStatus.SUCCESS,
      captured_at: data.capturedAt,
    };
    // Only overwrite what the caller actually learned. The reconcile path often
    // has no method and a null payment id; blanking the values the webhook
    // recorded would lose the only trace of how the money arrived.
    if (data.method != null) updateData['method'] = data.method;
    if (data.gatewayPaymentId != null) {
      updateData['gateway_payment_id'] = data.gatewayPaymentId;
    }
    if (data.gatewayResponse !== undefined) {
      updateData['gateway_response'] = data.gatewayResponse as Prisma.InputJsonValue;
    }

    const result = await this.prisma.payments.updateMany({
      where: {
        id: paymentId,
        business_id: businessId,
        status: { not: PaymentStatus.SUCCESS },
      },
      data: updateData,
    });

    const payment = await this.prisma.payments.findFirst({
      where: { id: paymentId, business_id: businessId },
    });
    if (!payment) {
      throw new ResourceNotFoundError('Payment', paymentId, {
        context: { businessId, stage: 'after-claim' },
      });
    }
    return { payment, claimed: result.count > 0 };
  }

  /**
   * Find a payment by gateway payment ID (used for webhook processing).
   * Not scoped by business — webhook processing looks up the payment globally
   * and then uses the payment's business_id for further operations.
   */
  async findPaymentByGatewayId(gatewayPaymentId: string): Promise<payments | null> {
    return this.prisma.payments.findFirst({
      where: {
        gateway_payment_id: gatewayPaymentId,
      },
    });
  }

  /**
   * Find a payment by gateway order ID (Razorpay order_id).
   */
  async findPaymentByGatewayOrderId(gatewayOrderId: string): Promise<payments | null> {
    return this.prisma.payments.findFirst({
      where: {
        gateway_order_id: gatewayOrderId,
      },
    });
  }

  /**
   * Find a payment by payment link ID.
   */
  async findPaymentByLinkId(paymentLinkId: string): Promise<payments | null> {
    return this.prisma.payments.findFirst({
      where: {
        payment_link_id: paymentLinkId,
      },
    });
  }

  /**
   * Sum COMPLETED refund amounts (rupees) for a payment — used to decide
   * whether a payment should flip to REFUNDED (fully) or PARTIALLY_REFUNDED.
   */
  async sumCompletedRefundsForPayment(
    businessId: string,
    paymentId: string,
  ): Promise<number> {
    const result = await this.prisma.refunds.aggregate({
      where: {
        business_id: businessId,
        payment_id: paymentId,
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });
    return Number(result._sum.amount ?? 0);
  }

  /**
   * Sum refund amounts (rupees) already committed against a payment — every
   * refund that has not been abandoned (INITIATED, PROCESSING, COMPLETED).
   *
   * Distinct from {@link sumCompletedRefundsForPayment}, which answers "how much
   * has settled" for the payment's status. This answers "how much is already
   * spoken for" and so must include refunds still in flight at the gateway: the
   * money has been requested, it just has not reached COMPLETED yet. FAILED and
   * REJECTED refunds moved nothing and are excluded.
   */
  async sumCommittedRefundsForPayment(
    businessId: string,
    paymentId: string,
  ): Promise<number> {
    const result = await this.prisma.refunds.aggregate({
      where: {
        business_id: businessId,
        payment_id: paymentId,
        status: {
          in: [RefundStatus.INITIATED, RefundStatus.PROCESSING, RefundStatus.COMPLETED],
        },
      },
      _sum: { amount: true },
    });
    return Number(result._sum.amount ?? 0);
  }

  // ─────────────────────────────────────────────
  // Refunds
  // ─────────────────────────────────────────────

  /**
   * Reserve refundable balance and write the refund row, atomically.
   *
   * Summing the committed refunds and then inserting a row is check-then-act on
   * a total that any concurrent caller can move. Two ₹300 refunds against one
   * ₹500 payment both read `committed = 0`, both find ₹500 available, and both
   * insert — ₹600 refunded against ₹500 collected.
   *
   * The gateway is not the backstop people assume. It does cap cumulative
   * refunds, but the paths that never reach it have nothing in their way:
   * a COD payment has no `gateway_payment_id` and is refunded purely in this
   * ledger, and an over-policy refund is recorded for human approval without a
   * gateway call. Those are exactly the refunds a person later pays out by hand,
   * against these numbers.
   *
   * `FOR UPDATE` on the parent payment is what serializes them. Every
   * reservation against a payment takes that one row lock, so the sum computed
   * under it cannot change before the insert commits; the second caller blocks,
   * re-reads a total that now includes the first, and is refused.
   *
   * The lock is held across two statements against one row and no external call
   * — the gateway request deliberately happens after this returns, since holding
   * a row lock across an HTTP round-trip would pin a connection from a pool this
   * deployment shares.
   */
  async reserveRefund(
    businessId: string,
    paymentId: string,
    data: {
      amountPaise: number;
      orderId?: string;
      currency?: string;
      reason?: string;
      requiresApproval?: boolean;
    },
  ): Promise<ReserveRefundResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ amount: Prisma.Decimal }>>`
        SELECT amount FROM payments
        WHERE id = ${paymentId}::uuid AND business_id = ${businessId}::uuid
        FOR UPDATE
      `;

      const row = locked[0];
      if (!row) {
        throw new ResourceNotFoundError('Payment', paymentId, {
          context: { businessId, stage: 'reserve-refund' },
        });
      }

      const originalAmountPaise = currencyToPaise(Number(row.amount));

      const committed = await tx.refunds.aggregate({
        where: {
          business_id: businessId,
          payment_id: paymentId,
          status: {
            in: [RefundStatus.INITIATED, RefundStatus.PROCESSING, RefundStatus.COMPLETED],
          },
        },
        _sum: { amount: true },
      });

      const committedPaise = currencyToPaise(Number(committed._sum.amount ?? 0));
      const refundablePaise = Math.max(0, originalAmountPaise - committedPaise);

      if (data.amountPaise > refundablePaise) {
        return {
          refund: null,
          reserved: false,
          originalAmountPaise,
          committedPaise,
          refundablePaise,
        };
      }

      const refund = await tx.refunds.create({
        data: {
          business_id: businessId,
          payment_id: paymentId,
          order_id: data.orderId ?? null,
          status: RefundStatus.INITIATED,
          amount: new Prisma.Decimal(data.amountPaise / 100),
          currency: data.currency ?? 'INR',
          reason: data.reason ?? null,
          requires_approval: data.requiresApproval ?? false,
          gateway_response: Prisma.JsonNull,
        },
      });

      return {
        refund,
        reserved: true,
        originalAmountPaise,
        committedPaise,
        refundablePaise,
      };
    });
  }

  /**
   * Create a refund record.
   */
  async createRefund(data: CreateRefundData): Promise<refunds> {
    return this.prisma.refunds.create({
      data: {
        business_id: data.businessId,
        payment_id: data.paymentId,
        order_id: data.orderId ?? null,
        status: 'INITIATED',
        amount: new Prisma.Decimal(data.amountRupees),
        currency: data.currency ?? 'INR',
        reason: data.reason ?? null,
        requires_approval: data.requiresApproval ?? false,
        gateway_refund_id: data.gatewayRefundId ?? null,
        gateway_response: data.gatewayResponse
          ? (data.gatewayResponse as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  }

  /**
   * Find a refund by its gateway refund ID (used for webhook processing).
   * Not scoped by business — webhook processing looks up the refund globally
   * and then uses the refund's business_id for further operations.
   */
  async findRefundByGatewayId(gatewayRefundId: string): Promise<refunds | null> {
    return this.prisma.refunds.findFirst({
      where: {
        gateway_refund_id: gatewayRefundId,
      },
    });
  }

  /**
   * Find a refund by ID within a business scope.
   */
  async getRefund(businessId: string, refundId: string): Promise<refunds | null> {
    return this.prisma.refunds.findFirst({
      where: {
        id: refundId,
        business_id: businessId,
      },
      include: {
        payment: true,
      },
    });
  }

  /**
   * List refunds for a business, paginated.
   */
  async listRefunds(
    businessId: string,
    filters: { paymentId?: string; orderId?: string; page?: number; limit?: number },
  ): Promise<PaginatedRefunds> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      business_id: businessId,
    };

    if (filters.paymentId) {
      where['payment_id'] = filters.paymentId;
    }
    if (filters.orderId) {
      where['order_id'] = filters.orderId;
    }

    const [data, total] = await Promise.all([
      this.prisma.refunds.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: { payment: true },
      }),
      this.prisma.refunds.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update a refund's status.
   */
  async updateRefundStatus(
    businessId: string,
    refundId: string,
    data: {
      status: string;
      gatewayRefundId?: string;
      gatewayResponse?: Record<string, unknown>;
      completedAt?: Date;
      failedAt?: Date;
      approvedBy?: string;
      approvedAt?: Date;
      rejectedBy?: string;
      rejectedAt?: Date;
      rejectionReason?: string;
    },
  ): Promise<refunds> {
    const existing = await this.prisma.refunds.findFirst({
      where: {
        id: refundId,
        business_id: businessId,
      },
    });

    if (!existing) {
      throw new ResourceNotFoundError('Refund', refundId, {
        context: { businessId },
      });
    }

    const updateData: Record<string, unknown> = {
      status: data.status,
    };

    if (data.gatewayRefundId !== undefined) {
      updateData['gateway_refund_id'] = data.gatewayRefundId;
    }
    if (data.gatewayResponse !== undefined) {
      updateData['gateway_response'] = data.gatewayResponse as Prisma.InputJsonValue;
    }
    if (data.completedAt !== undefined) {
      updateData['completed_at'] = data.completedAt;
    }
    if (data.failedAt !== undefined) {
      updateData['failed_at'] = data.failedAt;
    }
    if (data.approvedBy !== undefined) {
      updateData['approved_by'] = data.approvedBy;
    }
    if (data.approvedAt !== undefined) {
      updateData['approved_at'] = data.approvedAt;
    }
    if (data.rejectedBy !== undefined) {
      updateData['rejected_by'] = data.rejectedBy;
    }
    if (data.rejectedAt !== undefined) {
      updateData['rejected_at'] = data.rejectedAt;
    }
    if (data.rejectionReason !== undefined) {
      updateData['rejection_reason'] = data.rejectionReason;
    }

    return this.prisma.refunds.update({
      where: { id: refundId, business_id: businessId },
      data: updateData,
    });
  }

  // ─────────────────────────────────────────────
  // Aggregations
  // ─────────────────────────────────────────────

  /**
   * Get payment summary for an order: total paid, pending, refunded.
   * All amounts returned in rupees (Decimal(14,2)).
   */
  async getPaymentSummaryForOrder(
    businessId: string,
    orderId: string,
  ): Promise<PaymentSummaryResult> {
    const payments = await this.prisma.payments.findMany({
      where: {
        business_id: businessId,
        order_id: orderId,
      },
      select: {
        id: true,
        status: true,
        amount: true,
      },
    });

    let paidRupees = 0;
    let pendingRupees = 0;

    for (const payment of payments) {
      const amount = Number(payment.amount);
      if (payment.status === 'SUCCESS') {
        paidRupees += amount;
      } else if (payment.status === 'PENDING' || payment.status === 'INITIATED') {
        pendingRupees += amount;
      }
    }

    // Get total refunded
    const paymentIds = payments.map((p) => p.id);

    let refundedRupees = 0;

    if (paymentIds.length > 0) {
      const refundResult = await this.prisma.refunds.aggregate({
        where: {
          business_id: businessId,
          payment_id: { in: paymentIds },
          status: 'COMPLETED',
        },
        _sum: {
          amount: true,
        },
      });

      refundedRupees = Number(refundResult._sum.amount ?? 0);
    }

    return {
      paidRupees,
      pendingRupees,
      refundedRupees,
    };
  }

  // ─────────────────────────────────────────────
  // Webhook idempotency
  // ─────────────────────────────────────────────

  /**
   * Record a webhook event for idempotency.
   * Returns null if the event already exists (duplicate delivery).
   */
  async recordWebhookEvent(data: {
    businessId?: string;
    source: string;
    eventType: string;
    externalId: string;
    payload: Record<string, unknown>;
    headers: Record<string, unknown>;
    signatureValid: boolean;
  }): Promise<{ id: string } | null> {
    try {
      const event = await this.prisma.webhook_events.create({
        data: {
          business_id: data.businessId ?? null,
          source: data.source,
          event_type: data.eventType,
          external_id: data.externalId,
          payload: data.payload as Prisma.InputJsonValue,
          headers: data.headers as Prisma.InputJsonValue,
          signature_valid: data.signatureValid,
        },
        select: { id: true },
      });
      return event;
    } catch (error) {
      // Unique constraint violation = duplicate webhook, return null
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.debug(
          `Duplicate webhook event: source=${data.source}, externalId=${data.externalId}`,
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * Mark a webhook event as processed.
   */
  async markWebhookProcessed(webhookEventId: string): Promise<void> {
    await this.prisma.webhook_events.update({
      where: { id: webhookEventId },
      data: {
        processed: true,
        processed_at: new Date(),
      },
    });
  }

  // ─────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────

  /**
   * List payments still awaiting capture (PENDING or INITIATED) that have a
   * gateway link/order id, so reconciliation can poll the gateway for them.
   */
  async listReconcilablePayments(
    businessId: string,
    limit = 100,
  ): Promise<payments[]> {
    return this.prisma.payments.findMany({
      where: {
        business_id: businessId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] },
        OR: [
          { payment_link_id: { not: null } },
          { gateway_order_id: { not: null } },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
  }

  // ─────────────────────────────────────────────
  // Invoices
  // ─────────────────────────────────────────────

  /**
   * Create an invoice record (status DRAFT).
   */
  async createInvoice(data: CreateInvoiceData): Promise<invoices> {
    return this.prisma.invoices.create({
      data: {
        business_id: data.businessId,
        order_id: data.orderId ?? null,
        client_id: data.clientId,
        payment_id: data.paymentId ?? null,
        invoice_number: data.invoiceNumber,
        status: 'DRAFT',
        currency: data.currency ?? 'INR',
        subtotal: new Prisma.Decimal(data.subtotal),
        tax_amount: new Prisma.Decimal(data.taxAmount ?? 0),
        discount_amount: new Prisma.Decimal(data.discountAmount ?? 0),
        total: new Prisma.Decimal(data.total),
        line_items: data.lineItems as unknown as Prisma.InputJsonValue,
        notes: data.notes ?? null,
        due_at: data.dueAt ?? null,
      },
    });
  }

  /**
   * Find an invoice by ID within a business scope.
   */
  async getInvoice(businessId: string, invoiceId: string): Promise<invoices | null> {
    return this.prisma.invoices.findFirst({
      where: {
        id: invoiceId,
        business_id: businessId,
        deleted_at: null,
      },
    });
  }

  /**
   * Find the invoice attached to a payment (used to mark it PAID on capture).
   */
  async findInvoiceByPaymentId(paymentId: string): Promise<invoices | null> {
    return this.prisma.invoices.findFirst({
      where: {
        payment_id: paymentId,
        deleted_at: null,
      },
    });
  }

  /**
   * List invoices for a business with optional filters, paginated.
   */
  async listInvoices(
    businessId: string,
    filters: InvoiceListFilters,
  ): Promise<PaginatedInvoices> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      business_id: businessId,
      deleted_at: null,
    };

    if (filters.status) {
      where['status'] = filters.status;
    }
    if (filters.orderId) {
      where['order_id'] = filters.orderId;
    }
    if (filters.clientId) {
      where['client_id'] = filters.clientId;
    }

    const [data, total] = await Promise.all([
      this.prisma.invoices.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.invoices.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update an invoice's status and lifecycle timestamps.
   */
  async updateInvoiceStatus(
    businessId: string,
    invoiceId: string,
    data: {
      status: string;
      issuedAt?: Date;
      paidAt?: Date;
      paymentId?: string;
    },
  ): Promise<invoices> {
    const existing = await this.prisma.invoices.findFirst({
      where: { id: invoiceId, business_id: businessId, deleted_at: null },
    });

    if (!existing) {
      throw new ResourceNotFoundError('Invoice', invoiceId, {
        context: { businessId },
      });
    }

    const updateData: Record<string, unknown> = { status: data.status };

    if (data.issuedAt !== undefined) {
      updateData['issued_at'] = data.issuedAt;
    }
    if (data.paidAt !== undefined) {
      updateData['paid_at'] = data.paidAt;
    }
    if (data.paymentId !== undefined) {
      updateData['payment_id'] = data.paymentId;
    }

    return this.prisma.invoices.update({
      where: { id: invoiceId, business_id: businessId },
      data: updateData,
    });
  }

  /**
   * Count invoices a business has created in a given calendar year. Used to
   * derive the next sequential, per-business, per-year invoice number.
   */
  async countInvoicesForYear(businessId: string, year: number): Promise<number> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    return this.prisma.invoices.count({
      where: {
        business_id: businessId,
        created_at: { gte: start, lt: end },
      },
    });
  }

  /**
   * The highest invoice sequence issued for this business and year, or 0 when
   * none has been.
   *
   * Numbering read `countInvoicesForYear() + 1`, which is wrong twice over. It
   * re-issues a number the moment the sequence has a gap — and an invoice
   * number, once handed to a customer on a GST invoice, is issued whether or
   * not its row survived. It also counts by `created_at` while the number
   * encodes the year, so an invoice created just either side of the new year
   * boundary is counted into one year and numbered into the other.
   *
   * Reading the maximum from the numbers themselves keeps those two in
   * agreement, and answers from the unique index rather than a yearly count.
   */
  async findHighestInvoiceSequenceForYear(businessId: string, year: number): Promise<number> {
    const prefix = `INV-${year}-`;

    // Fixed-width zero padding makes lexicographic order numeric order.
    const latest = await this.prisma.invoices.findFirst({
      where: {
        business_id: businessId,
        invoice_number: { startsWith: prefix },
      },
      orderBy: { invoice_number: 'desc' },
      select: { invoice_number: true },
    });

    // Anything that does not parse — a legacy or hand-written number — reports
    // zero. Returning NaN would render the next number as "INV-2026-000NaN"
    // and then collide with itself on every subsequent invoice.
    const stored = typeof latest?.invoice_number === 'string' ? latest.invoice_number : '';
    const parsed = Number.parseInt(stored.slice(prefix.length), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }


  /**
   * Aggregate payment stats for the dashboard. `payments.amount` is stored in
   * rupees (Decimal(14,2)), not paise, so every amount is converted via
   * `currencyToPaise()` — do not read a non-existent `amount_paise` column.
   * Refunded amounts come from the `refunds` table (status COMPLETED) rather
   * than the payment row, since a payment only records its own gross amount.
   */
  async getPaymentStats(
    businessId: string,
    params: { from?: string; to?: string },
  ) {
    const where: Prisma.paymentsWhereInput = { business_id: businessId };
    if (params.from || params.to) {
      where.created_at = {};
      if (params.from) where.created_at.gte = new Date(params.from);
      if (params.to) where.created_at.lte = new Date(params.to);
    }

    // Counts and sums are computed in the database. Reading the rows to add
    // them up in JS meant the whole payment history of a tenant landed in
    // memory for what is a dashboard tile, and the refund lookup that followed
    // built an `IN (...)` holding every payment id — which stops working long
    // before the memory does. The refunds side is scoped through the payment
    // relation instead, so it inherits the same tenant + date window without
    // needing the id list.
    const [byStatus, refundAgg] = await Promise.all([
      this.prisma.payments.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.refunds.aggregate({
        where: {
          business_id: businessId,
          status: RefundStatus.COMPLETED,
          payment: where,
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const totalTransactions = byStatus.reduce((s, row) => s + row._count._all, 0);
    const successRow = byStatus.find((row) => row.status === PaymentStatus.SUCCESS);
    const successfulCount = successRow?._count._all ?? 0;
    // Decimal(14,2) rupees → paise. Rounding the sum is exact here because each
    // row already has at most two decimal places.
    const totalRevenue = currencyToPaise(Number(successRow?._sum.amount ?? 0));

    return {
      totalRevenue,
      totalTransactions,
      successRate:
        totalTransactions > 0
          ? Math.round((successfulCount / totalTransactions) * 100) / 100
          : 0,
      avgTransactionValue:
        successfulCount > 0 ? Math.round(totalRevenue / successfulCount) : 0,
      refundedAmount: currencyToPaise(Number(refundAgg._sum.amount ?? 0)),
      refundCount: refundAgg._count._all,
    };
  }

}
