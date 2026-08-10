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

  // ─────────────────────────────────────────────
  // Refunds
  // ─────────────────────────────────────────────

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
    const payments = await this.prisma.payments.findMany({
      where,
      select: { id: true, status: true, amount: true },
    });
    const successful = payments.filter((p) => p.status === PaymentStatus.SUCCESS);
    const totalRevenue = successful.reduce(
      (s, p) => s + currencyToPaise(Number(p.amount)),
      0,
    );

    const paymentIds = payments.map((p) => p.id);
    let refundedAmt = 0;
    let refundCount = 0;
    if (paymentIds.length > 0) {
      const refunds = await this.prisma.refunds.findMany({
        where: {
          business_id: businessId,
          payment_id: { in: paymentIds },
          status: RefundStatus.COMPLETED,
        },
        select: { amount: true },
      });
      refundedAmt = refunds.reduce((s, r) => s + currencyToPaise(Number(r.amount)), 0);
      refundCount = refunds.length;
    }

    return {
      totalRevenue,
      totalTransactions: payments.length,
      successRate: payments.length > 0 ? Math.round((successful.length / payments.length) * 100) / 100 : 0,
      avgTransactionValue: successful.length > 0 ? Math.round(totalRevenue / successful.length) : 0,
      refundedAmount: refundedAmt,
      refundCount,
    };
  }

}
