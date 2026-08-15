import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import type { payments, refunds } from '@prisma/client';
import {
  PaymentStatus,
  PaymentGateway,
  PaymentMethod,
  RefundStatus,
  generateId,
  generateCorrelationId,
  currencyToPaise,
} from '@gosumo/shared';
import type {
  PaymentCreatedEvent,
  PaymentSuccessEvent,
  PaymentFailedEvent,
  PaymentRefundEvent,
  OrderCreatedEvent,
} from '@gosumo/shared';
import {
  PaymentRepository,
  PaginatedPayments,
} from './payment.repository';
import {
  RazorpayService,
} from './razorpay.service';
import { StripeService } from './stripe.service';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import {
  CreatePaymentLinkDto,
  PaymentLinkDto,
  TransactionDto,
  InitiateRefundDto,
  RefundDto,
  ConfirmCODDto,
  PaymentSummaryDto,
  ListPaymentsQueryDto,
  ReconcileResultDto,
  ReconciliationSummaryDto,
} from './dto';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Default payment link expiry: 24 hours in minutes */
const PAYMENT_LINK_EXPIRY_MINUTES = 1440;

/** Default max refund amount in paise (10 lakh = 1,000,000 paise = 10,000 INR) */
const DEFAULT_MAX_REFUND_AMOUNT_PAISE = 1_000_000;

// ─────────────────────────────────────────────
// Razorpay webhook event types
// ─────────────────────────────────────────────

interface RazorpayWebhookPayload {
  entity: string;
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    payment_link?: {
      entity: {
        id: string;
        status: string;
        amount: number;
        amount_paid: number;
      };
    };
    payment?: {
      entity: {
        id: string;
        amount: number;
        currency: string;
        status: string;
        order_id?: string;
        method?: string;
        error_code?: string;
        error_description?: string;
        notes?: Record<string, string>;
      };
    };
    refund?: {
      entity: {
        id: string;
        payment_id: string;
        amount: number;
        status: string;
      };
    };
  };
}

// ─────────────────────────────────────────────
// Stripe webhook event types
// ─────────────────────────────────────────────

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      object: string;
      amount?: number;
      amount_total?: number;
      currency?: string;
      status?: string;
      payment_status?: string;
      payment_intent?: string | null;
      payment_method_types?: string[];
      last_payment_error?: { message?: string; code?: string };
      metadata?: Record<string, string>;
    };
  };
}

/**
 * PaymentService — core business logic for payments, refunds, and webhooks.
 *
 * Owns:
 *  - Payment link creation (Razorpay)
 *  - Razorpay webhook processing (with HMAC-SHA256 verification + idempotency)
 *  - Refund initiation (with policy enforcement and HITL routing)
 *  - COD payment confirmation
 *  - Payment summary aggregation
 *
 * Emits:
 *  - payment.created, payment.success, payment.failed
 *  - payment.refund.initiated, payment.refund.completed
 *
 * Listens:
 *  - order.created → auto-create payment link for ONLINE orders
 */
@Injectable()
export class PaymentService implements OnModuleInit {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly repository: PaymentRepository,
    private readonly razorpay: RazorpayService,
    private readonly stripe: StripeService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly webhookDlq: WebhookDlqService,
  ) {}

  /**
   * Teach the webhook DLQ how to re-run a gateway event.
   *
   * Both replayers skip signature verification, and must: the payload only
   * reached the DLQ because its signature already passed, and the raw bytes
   * that verification needs are not stored. They also skip the `webhook_events`
   * idempotency write, which by definition already happened.
   */
  onModuleInit(): void {
    this.webhookDlq.registerReplayer('RAZORPAY', async (payload) => {
      await this.dispatchRazorpayEvent(payload as unknown as RazorpayWebhookPayload);
    });
    this.webhookDlq.registerReplayer('STRIPE', async (payload) => {
      await this.dispatchStripeEvent(payload as unknown as StripeWebhookEvent);
    });
  }

  /**
   * Resolve which gateway to use for a payment link.
   * Explicit override wins; otherwise INR → Razorpay, anything else → Stripe.
   */
  private resolveGateway(
    currency: string,
    override?: PaymentGateway,
  ): PaymentGateway {
    if (override) {
      return override;
    }
    return currency.toUpperCase() === 'INR'
      ? PaymentGateway.RAZORPAY
      : PaymentGateway.STRIPE;
  }

  // ─────────────────────────────────────────────
  // Payment Link CRUD
  // ─────────────────────────────────────────────

  /**
   * Create a payment link via Razorpay and store the payment record.
   * Default expiry is 24 hours (1440 minutes).
   *
   * Emits `payment.created`.
   */
  async createPaymentLink(
    businessId: string,
    dto: CreatePaymentLinkDto,
  ): Promise<PaymentLinkDto> {
    const currency = (dto.currency ?? 'INR').toUpperCase();
    const gateway = this.resolveGateway(currency, dto.gateway);
    const expiryMinutes = dto.expiryMinutes ?? PAYMENT_LINK_EXPIRY_MINUTES;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Amount in the currency major unit for DB storage (Decimal(14,2)).
    const amountMajor = dto.amountPaise / 100;

    let paymentLinkUrl: string;
    let paymentLinkId: string;

    if (gateway === PaymentGateway.STRIPE) {
      const session = await this.stripe.createCheckoutSession({
        amountMinor: dto.amountPaise,
        currency,
        description: dto.description,
        customerEmail: dto.customerEmail,
        referenceId: dto.orderId,
        metadata: {
          businessId,
          clientId: dto.clientId,
          ...(dto.orderId ? { orderId: dto.orderId } : {}),
        },
      });
      paymentLinkUrl = session.url;
      paymentLinkId = session.id;
    } else {
      const expireBy = Math.floor(expiresAt.getTime() / 1000);
      const razorpayResult = await this.razorpay.createPaymentLink({
        amountPaise: dto.amountPaise,
        currency,
        description: dto.description,
        expireBy,
        referenceId: dto.orderId,
        notes: {
          businessId,
          clientId: dto.clientId,
          ...(dto.orderId ? { orderId: dto.orderId } : {}),
        },
      });
      paymentLinkUrl = razorpayResult.shortUrl;
      paymentLinkId = razorpayResult.id;
    }

    // Store payment record in DB
    const payment = await this.repository.createPayment({
      businessId,
      orderId: dto.orderId,
      clientId: dto.clientId,
      amountRupees: amountMajor,
      currency,
      gateway,
      paymentLinkUrl,
      paymentLinkId,
      paymentLinkExpiresAt: expiresAt,
    });

    // Emit domain event
    const event: PaymentCreatedEvent = {
      type: 'payment.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: dto.orderId,
      clientId: dto.clientId,
      amountPaise: dto.amountPaise,
      currency,
      paymentLinkUrl,
    };

    this.eventEmitter.emit('payment.created', event);

    this.logger.log(
      `Created ${gateway} payment link ${payment.id} for client ${dto.clientId} — ${dto.amountPaise} ${currency} minor units`,
    );

    return this.toPaymentLinkDto(payment);
  }

  /**
   * Get a single payment link by ID.
   */
  async getPaymentLink(
    businessId: string,
    paymentId: string,
  ): Promise<PaymentLinkDto> {
    const payment = await this.repository.getPayment(businessId, paymentId);

    if (!payment) {
      throw new NotFoundException(`Payment not found: ${paymentId}`);
    }

    return this.toPaymentLinkDto(payment);
  }

  /**
   * Cancel a pending payment link.
   * Only PENDING or INITIATED payments can be cancelled.
   */
  async cancelPaymentLink(
    businessId: string,
    paymentId: string,
  ): Promise<PaymentLinkDto> {
    const payment = await this.repository.getPayment(businessId, paymentId);

    if (!payment) {
      throw new NotFoundException(`Payment not found: ${paymentId}`);
    }

    const status = payment.status as string;

    if (status !== PaymentStatus.PENDING && status !== PaymentStatus.INITIATED) {
      throw new BadRequestException(
        `Cannot cancel payment in status ${status}. Only PENDING or INITIATED payments can be cancelled.`,
      );
    }

    const updated = await this.repository.updatePaymentStatus(
      businessId,
      paymentId,
      {
        status: PaymentStatus.EXPIRED,
        failedAt: new Date(),
        failureReason: 'Cancelled by user',
      },
    );

    this.logger.log(`Payment link ${paymentId} cancelled`);

    return this.toPaymentLinkDto(updated);
  }

  /**
   * List payment links for a business with optional filters.
   */
  async listPaymentLinks(
    businessId: string,
    query: ListPaymentsQueryDto,
  ): Promise<PaginatedPayments> {
    return this.repository.listPayments(businessId, {
      status: query.status,
      orderId: query.orderId,
      clientId: query.clientId,
      page: query.page,
      limit: query.limit,
    });
  }

  // ─────────────────────────────────────────────
  // Razorpay Webhook Processing
  // ─────────────────────────────────────────────

  /**
   * Handle an incoming Razorpay webhook.
   *
   * 1. Verify HMAC-SHA256 signature — reject if invalid
   * 2. Check idempotency via webhook_events table
   * 3. Process the event based on type
   * 4. Emit domain events
   */
  async handleRazorpayWebhook(
    payload: Buffer | string,
    signature: string,
  ): Promise<void> {
    // Step 1: ALWAYS verify webhook signature first
    const isValid = this.razorpay.verifyWebhookSignature(payload, signature);

    if (!isValid) {
      this.logger.warn('Invalid Razorpay webhook signature — rejecting');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Parse the payload
    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const webhookData: RazorpayWebhookPayload = JSON.parse(payloadStr);
    const eventType = webhookData.event;

    // Derive a unique external ID for idempotency
    const externalId = this.deriveWebhookExternalId(webhookData);

    // Step 2: Check idempotency — record the webhook event
    const webhookEvent = await this.repository.recordWebhookEvent({
      source: 'RAZORPAY',
      eventType,
      externalId,
      payload: webhookData as unknown as Record<string, unknown>,
      headers: {},
      signatureValid: true,
    });

    if (!webhookEvent) {
      // Duplicate webhook — silently skip
      this.logger.debug(`Duplicate Razorpay webhook: ${eventType} (${externalId})`);
      return;
    }

    // Step 3: Process the event
    try {
      await this.dispatchRazorpayEvent(webhookData);

      // Mark as processed
      await this.repository.markWebhookProcessed(webhookEvent.id);
    } catch (error) {
      this.logger.error(
        `Error processing Razorpay webhook ${eventType}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.deadLetterWebhook(
        'RAZORPAY',
        eventType,
        externalId,
        webhookData as unknown as Record<string, unknown>,
        webhookEvent.id,
        await this.resolveRazorpayBusinessId(webhookData),
        error,
      );
      throw error;
    }
  }

  /**
   * Route a verified Razorpay event to its handler.
   *
   * Split out from {@link handleRazorpayWebhook} so a DLQ replay re-runs
   * exactly the processing that failed — not the signature check (whose raw
   * bytes are gone) and not the idempotency write (which already happened).
   */
  private async dispatchRazorpayEvent(webhookData: RazorpayWebhookPayload): Promise<void> {
    switch (webhookData.event) {
      case 'payment_link.paid':
        await this.handlePaymentLinkPaid(webhookData);
        break;
      case 'payment.authorized':
      case 'payment.captured':
        await this.handlePaymentCaptured(webhookData);
        break;
      case 'payment.failed':
        await this.handlePaymentFailed(webhookData);
        break;
      case 'refund.processed':
        await this.handleRefundProcessed(webhookData);
        break;
      default:
        this.logger.debug(`Unhandled Razorpay event type: ${webhookData.event}`);
    }
  }

  // ─────────────────────────────────────────────
  // Stripe Webhook Processing
  // ─────────────────────────────────────────────

  /**
   * Handle an incoming Stripe webhook.
   *
   * 1. Verify the `Stripe-Signature` header — reject if invalid
   * 2. Check idempotency via webhook_events table (keyed on the event id)
   * 3. Process the event based on type
   * 4. Emit domain events
   */
  async handleStripeWebhook(
    payload: Buffer | string,
    signatureHeader: string,
  ): Promise<void> {
    // Step 1: ALWAYS verify webhook signature first
    const isValid = this.stripe.verifyWebhookSignature(payload, signatureHeader);

    if (!isValid) {
      this.logger.warn('Invalid Stripe webhook signature — rejecting');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const stripeEvent: StripeWebhookEvent = JSON.parse(payloadStr);
    const eventType = stripeEvent.type;

    // Step 2: Idempotency — Stripe event ids (evt_xxx) are globally unique.
    const webhookEvent = await this.repository.recordWebhookEvent({
      source: 'STRIPE',
      eventType,
      externalId: stripeEvent.id,
      payload: stripeEvent as unknown as Record<string, unknown>,
      headers: {},
      signatureValid: true,
    });

    if (!webhookEvent) {
      this.logger.debug(`Duplicate Stripe webhook: ${eventType} (${stripeEvent.id})`);
      return;
    }

    // Step 3: Process the event
    try {
      await this.dispatchStripeEvent(stripeEvent);

      await this.repository.markWebhookProcessed(webhookEvent.id);
    } catch (error) {
      this.logger.error(
        `Error processing Stripe webhook ${eventType}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.deadLetterWebhook(
        'STRIPE',
        eventType,
        stripeEvent.id,
        stripeEvent as unknown as Record<string, unknown>,
        webhookEvent.id,
        await this.resolveStripeBusinessId(stripeEvent),
        error,
      );
      throw error;
    }
  }

  /** Route a verified Stripe event to its handler. See {@link dispatchRazorpayEvent}. */
  private async dispatchStripeEvent(stripeEvent: StripeWebhookEvent): Promise<void> {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await this.handleStripeCheckoutCompleted(stripeEvent);
        break;
      case 'checkout.session.expired':
        await this.handleStripeCheckoutExpired(stripeEvent);
        break;
      case 'payment_intent.payment_failed':
        await this.handleStripePaymentFailed(stripeEvent);
        break;
      case 'charge.refunded':
      case 'refund.updated':
        this.logger.log(`Stripe refund event: ${stripeEvent.type} (${stripeEvent.id})`);
        break;
      default:
        this.logger.debug(`Unhandled Stripe event type: ${stripeEvent.type}`);
    }
  }

  // ─────────────────────────────────────────────
  // Webhook dead-lettering
  // ─────────────────────────────────────────────

  /**
   * Park a failed gateway webhook for retry.
   *
   * Without this the event is gone: `webhook_events` recorded it before
   * processing, so every redelivery the gateway makes is discarded as a
   * duplicate. A payment the customer really made would stay PENDING until
   * reconciliation happened to catch it.
   *
   * Never throws — a DLQ that fails must not change what the gateway sees.
   */
  private async deadLetterWebhook(
    source: 'RAZORPAY' | 'STRIPE',
    eventType: string,
    externalId: string,
    payload: Record<string, unknown>,
    webhookEventId: string,
    businessId: string | null,
    error: unknown,
  ): Promise<void> {
    try {
      await this.webhookDlq.capture(
        { businessId, webhookEventId, source, eventType, externalId, payload },
        error,
      );
    } catch (dlqError) {
      this.logger.error(
        `Failed to dead-letter ${source} webhook ${externalId}: ` +
          `${dlqError instanceof Error ? dlqError.message : String(dlqError)}`,
      );
    }
  }

  /**
   * Best-effort tenant for a failed Razorpay event, so the entry lands in the
   * right business's queue rather than the platform-level bucket.
   *
   * Returns null rather than throwing: this runs while already handling a
   * failure, and an unresolvable tenant is a worse queue view, not a worse
   * outcome — the retry itself does not depend on it.
   */
  private async resolveRazorpayBusinessId(
    data: RazorpayWebhookPayload,
  ): Promise<string | null> {
    try {
      const paymentEntityId = data.payload?.payment?.entity?.id;
      if (paymentEntityId) {
        const byPayment = await this.repository.findPaymentByGatewayId(paymentEntityId);
        if (byPayment) return byPayment.business_id;
      }

      const linkId = data.payload?.payment_link?.entity?.id;
      if (linkId) {
        const byLink = await this.repository.findPaymentByLinkId(linkId);
        if (byLink) return byLink.business_id;
      }

      const refundId = data.payload?.refund?.entity?.id;
      if (refundId) {
        const byRefund = await this.repository.findRefundByGatewayId(refundId);
        if (byRefund) return byRefund.business_id;
      }
    } catch (err) {
      this.logger.debug(
        `Could not resolve business for Razorpay webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }

  /** Best-effort tenant for a failed Stripe event. See {@link resolveRazorpayBusinessId}. */
  private async resolveStripeBusinessId(
    event: StripeWebhookEvent,
  ): Promise<string | null> {
    try {
      const sessionId = event.data?.object?.id;
      if (sessionId) {
        const bySession = await this.repository.findPaymentByLinkId(sessionId);
        if (bySession) return bySession.business_id;
      }
      const intentId = event.data?.object?.payment_intent;
      if (intentId) {
        const byIntent = await this.repository.findPaymentByGatewayId(intentId);
        if (byIntent) return byIntent.business_id;
      }
    } catch (err) {
      this.logger.debug(
        `Could not resolve business for Stripe webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }

  // ─────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────

  /**
   * Reconcile a single payment against its gateway. If the gateway reports a
   * terminal state that the DB hasn't caught up to (e.g. a webhook was missed),
   * update the local record and emit the appropriate domain event.
   */
  async reconcilePayment(
    businessId: string,
    paymentId: string,
  ): Promise<ReconcileResultDto> {
    const payment = await this.repository.getPayment(businessId, paymentId);
    if (!payment) {
      throw new NotFoundException(`Payment not found: ${paymentId}`);
    }

    const previousStatus = payment.status as string;

    // Only PENDING/INITIATED payments are reconcilable.
    if (
      previousStatus !== PaymentStatus.PENDING &&
      previousStatus !== PaymentStatus.INITIATED
    ) {
      return {
        paymentId,
        previousStatus,
        currentStatus: previousStatus,
        changed: false,
      };
    }

    let currentStatus = previousStatus;
    let gatewayStatus: string | undefined;
    const gateway = payment.gateway as string;

    try {
      if (gateway === PaymentGateway.RAZORPAY && payment.payment_link_id) {
        const status = await this.razorpay.fetchPaymentLinkStatus(
          payment.payment_link_id,
        );
        gatewayStatus = status.status;
        if (status.status === 'paid') {
          await this.markReconciledSuccess(payment, status.paymentId ?? null);
          currentStatus = PaymentStatus.SUCCESS;
        } else if (status.status === 'cancelled' || status.status === 'expired') {
          await this.repository.updatePaymentStatus(businessId, paymentId, {
            status: PaymentStatus.EXPIRED,
            failedAt: new Date(),
            failureReason: `Gateway status: ${status.status}`,
          });
          currentStatus = PaymentStatus.EXPIRED;
        }
      } else if (gateway === PaymentGateway.STRIPE && payment.payment_link_id) {
        const status = await this.stripe.fetchSessionStatus(payment.payment_link_id);
        gatewayStatus = status.paymentStatus;
        if (status.paymentStatus === 'paid') {
          await this.markReconciledSuccess(payment, status.paymentIntentId ?? null);
          currentStatus = PaymentStatus.SUCCESS;
        } else if (status.status === 'expired') {
          await this.repository.updatePaymentStatus(businessId, paymentId, {
            status: PaymentStatus.EXPIRED,
            failedAt: new Date(),
            failureReason: 'Gateway status: expired',
          });
          currentStatus = PaymentStatus.EXPIRED;
        }
      }
    } catch (error) {
      this.logger.error(
        `Reconciliation failed for payment ${paymentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      paymentId,
      previousStatus,
      currentStatus,
      changed: currentStatus !== previousStatus,
      gatewayStatus,
    };
  }

  /**
   * Reconcile all reconcilable (PENDING/INITIATED) payments for a business.
   */
  async reconcilePendingPayments(
    businessId: string,
  ): Promise<ReconciliationSummaryDto> {
    const payments = await this.repository.listReconcilablePayments(businessId);
    const results: ReconcileResultDto[] = [];

    for (const payment of payments) {
      const result = await this.reconcilePayment(businessId, payment.id);
      results.push(result);
    }

    const updated = results.filter((r) => r.changed).length;

    this.logger.log(
      `Reconciled ${results.length} payments for business ${businessId} — ${updated} updated`,
    );

    return {
      checked: results.length,
      updated,
      results,
    };
  }

  // ─────────────────────────────────────────────
  // Refunds
  // ─────────────────────────────────────────────

  /**
   * Initiate a refund against a payment.
   *
   * Business rules enforced:
   *  1. Refund amount cannot exceed original transaction amount
   *  2. If amount exceeds business policy maxRefundAmountPaise,
   *     route to HITL (requires_approval=true) instead of auto-processing
   *
   * Emits `payment.refund.initiated`.
   */
  async initiateRefund(
    businessId: string,
    dto: InitiateRefundDto,
  ): Promise<RefundDto> {
    // Look up the original payment
    const payment = await this.repository.getPayment(businessId, dto.transactionId);

    if (!payment) {
      throw new NotFoundException(`Payment not found: ${dto.transactionId}`);
    }

    // Check payment is in a refundable state
    const paymentStatus = payment.status as string;
    if (paymentStatus !== PaymentStatus.SUCCESS &&
        paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED) {
      throw new BadRequestException(
        `Cannot refund payment in status ${paymentStatus}. Payment must be SUCCESS or PARTIALLY_REFUNDED.`,
      );
    }

    // Rule 2: Check business policy max refund amount
    const maxRefundPaise = this.configService.get<number>(
      'BUSINESS_MAX_REFUND_PAISE',
      DEFAULT_MAX_REFUND_AMOUNT_PAISE,
    );

    const requiresApproval = dto.amountPaise > maxRefundPaise;

    // Rule 1: a refund cannot take the payment past what the customer actually
    // paid. The ceiling is the original amount MINUS what is already committed —
    // a PARTIALLY_REFUNDED payment is refundable again, so checking only against
    // the original would let ₹500 be refunded twice on a ₹500 payment. Refunds
    // still in flight at the gateway count against the ceiling too; they settle
    // asynchronously, so waiting for COMPLETED would leave the same gap open for
    // as long as the gateway takes to confirm.
    //
    // The check and the row that consumes the balance happen under one lock on
    // the payment. Read separately, two concurrent refunds both see the whole
    // balance free and both take it. The gateway would refuse the overdraft on
    // the paths that reach it — but a COD payment has no gateway, and an
    // over-policy refund is recorded for approval without calling one, so on
    // exactly the paths a human later pays out by hand there is nothing else
    // holding the line.
    const reservation = await this.repository.reserveRefund(businessId, dto.transactionId, {
      amountPaise: dto.amountPaise,
      orderId: payment.order_id ?? undefined,
      currency: payment.currency,
      reason: dto.reason,
      requiresApproval,
    });

    if (!reservation.reserved || !reservation.refund) {
      throw new BadRequestException(
        `Refund amount (${dto.amountPaise} paise) exceeds the refundable balance ` +
          `(${reservation.refundablePaise} paise) on payment ${dto.transactionId} — original ` +
          `${reservation.originalAmountPaise} paise, ${reservation.committedPaise} paise already refunded`,
      );
    }

    let refund = reservation.refund;

    // If within policy, process via the originating gateway. This runs after the
    // reservation, not before it: the row is what reserves the balance, and it
    // must exist before money moves. Called first, a gateway refund whose insert
    // then failed would have moved money this ledger has no record of at all.
    if (!requiresApproval && payment.gateway_payment_id) {
      const gateway = payment.gateway as string;
      try {
        let gatewayRefundId: string;
        let gatewayResponse: Record<string, unknown>;

        if (gateway === PaymentGateway.STRIPE) {
          const stripeRefund = await this.stripe.createRefund(
            payment.gateway_payment_id,
            dto.amountPaise,
          );
          gatewayRefundId = stripeRefund.id;
          gatewayResponse = stripeRefund as unknown as Record<string, unknown>;
        } else {
          const razorpayRefund = await this.razorpay.createRefund(
            payment.gateway_payment_id,
            dto.amountPaise,
          );
          gatewayRefundId = razorpayRefund.id;
          gatewayResponse = razorpayRefund as unknown as Record<string, unknown>;
        }

        refund = await this.repository.updateRefundStatus(businessId, refund.id, {
          status: RefundStatus.INITIATED,
          gatewayRefundId,
          gatewayResponse,
        });
      } catch (error) {
        this.logger.error(
          `${gateway} refund failed for payment ${dto.transactionId}: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Release the reservation. FAILED is outside the committed set, so the
        // balance this row was holding returns to the payment — otherwise a
        // gateway error would permanently strand money as unrefundable.
        try {
          await this.repository.updateRefundStatus(businessId, refund.id, {
            status: RefundStatus.FAILED,
            failedAt: new Date(),
          });
        } catch (releaseError) {
          // Worth its own line: the refund is now holding balance it will never
          // use, and only a person reading this will know to clear it.
          this.logger.error(
            `Failed to release refund reservation ${refund.id} after a gateway error: ` +
              `${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        }

        throw new BadRequestException('Failed to process refund with payment gateway');
      }
    }

    // Emit domain event
    const event: PaymentRefundEvent = {
      type: 'payment.refund.initiated',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      refundId: refund.id,
      paymentId: dto.transactionId,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: dto.amountPaise,
      currency: payment.currency,
      reason: dto.reason,
    };

    this.eventEmitter.emit('payment.refund.initiated', event);

    if (requiresApproval) {
      this.logger.log(
        `Refund ${refund.id} requires approval (${dto.amountPaise} paise exceeds policy limit of ${maxRefundPaise} paise)`,
      );
    } else {
      this.logger.log(
        `Refund ${refund.id} initiated for ${dto.amountPaise} paise against payment ${dto.transactionId}`,
      );
    }

    return this.toRefundDto(refund);
  }

  /**
   * List refunds for a business with optional filters.
   */
  async listRefunds(
    businessId: string,
    filters: { paymentId?: string; orderId?: string; page?: number; limit?: number },
  ) {
    const result = await this.repository.listRefunds(businessId, filters);
    return {
      data: result.data.map((r) => this.toRefundDto(r)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Get a refund by ID.
   */
  async getRefund(businessId: string, refundId: string): Promise<RefundDto> {
    const refund = await this.repository.getRefund(businessId, refundId);

    if (!refund) {
      throw new NotFoundException(`Refund not found: ${refundId}`);
    }

    return this.toRefundDto(refund);
  }

  // ─────────────────────────────────────────────
  // COD Payment Confirmation
  // ─────────────────────────────────────────────

  /**
   * Confirm a Cash-On-Delivery payment.
   * Records the payment with gateway=MANUAL, method=COD.
   *
   * Emits `payment.success`.
   */
  async confirmCODPayment(
    businessId: string,
    dto: ConfirmCODDto,
  ): Promise<TransactionDto> {
    const amountRupees = dto.amountPaise / 100;

    // Create payment record for COD
    const payment = await this.repository.createPayment({
      businessId,
      orderId: dto.orderId,
      clientId: dto.clientId,
      amountRupees,
      gateway: PaymentGateway.MANUAL,
      metadata: {
        collectedBy: dto.collectedBy,
        type: 'COD',
      },
    });

    // Update status to SUCCESS with COD method
    const updated = await this.repository.updatePaymentStatus(
      businessId,
      payment.id,
      {
        status: PaymentStatus.SUCCESS,
        method: PaymentMethod.COD,
        capturedAt: new Date(),
      },
    );

    // Emit payment.success event
    const event: PaymentSuccessEvent = {
      type: 'payment.success',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      paymentId: updated.id,
      orderId: dto.orderId,
      clientId: updated.client_id,
      amountPaise: dto.amountPaise,
      currency: 'INR',
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: 'MANUAL_COD',
    };

    this.eventEmitter.emit('payment.success', event);

    this.logger.log(
      `COD payment ${updated.id} confirmed for order ${dto.orderId} — ${dto.amountPaise} paise collected by ${dto.collectedBy}`,
    );

    return this.toTransactionDto(updated);
  }

  // ─────────────────────────────────────────────
  // Payment Summary
  // ─────────────────────────────────────────────

  /**
   * Get aggregated payment summary for an order.
   * Returns paid, pending, and refunded amounts in paise.
   */
  async getPaymentSummaryForOrder(
    businessId: string,
    orderId: string,
  ): Promise<PaymentSummaryDto> {
    const summary = await this.repository.getPaymentSummaryForOrder(
      businessId,
      orderId,
    );

    return {
      paidPaise: currencyToPaise(summary.paidRupees),
      pendingPaise: currencyToPaise(summary.pendingRupees),
      refundedPaise: currencyToPaise(summary.refundedRupees),
      currency: 'INR',
      orderId,
    };
  }

  // ─────────────────────────────────────────────
  // Event Listeners
  // ─────────────────────────────────────────────

  /**
   * Listen for order.created events.
   * If the order's metadata indicates paymentMethod is ONLINE,
   * auto-create a payment link.
   */

  async getPaymentStats(businessId: string, params: { from?: string; to?: string }) {
    return this.repository.getPaymentStats(businessId, params);
  }


  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    // Check if order metadata specifies online payment
    // The event contains basic info; we check if totalPaise > 0
    // and the order is newly created (not a draft).
    // The actual paymentMethod check would come from the order metadata.
    // For the event-driven pattern, we attempt to create if totalPaise > 0.
    try {
      const dto: CreatePaymentLinkDto = {
        orderId: event.orderId,
        clientId: event.clientId,
        amountPaise: event.totalPaise,
        description: `Payment for order ${event.orderNumber}`,
      };

      await this.createPaymentLink(event.businessId, dto);

      this.logger.log(
        `Auto-created payment link for order ${event.orderNumber} (${event.totalPaise} paise)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to auto-create payment link for order ${event.orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Status helper
  // ─────────────────────────────────────────────

  getStatus(): Record<string, string> {
    return { module: 'Payment', status: 'ready' };
  }

  // ─────────────────────────────────────────────
  // Private: Webhook event handlers
  // ─────────────────────────────────────────────

  private async handlePaymentLinkPaid(
    webhookData: RazorpayWebhookPayload,
  ): Promise<void> {
    const paymentLinkEntity = webhookData.payload.payment_link?.entity;
    const paymentEntity = webhookData.payload.payment?.entity;

    if (!paymentLinkEntity) {
      this.logger.warn('payment_link.paid webhook missing payment_link entity');
      return;
    }

    // Find our payment record by payment link ID
    const payment = await this.repository.findPaymentByLinkId(
      paymentLinkEntity.id,
    );

    if (!payment) {
      this.logger.warn(
        `No payment found for payment link ${paymentLinkEntity.id}`,
      );
      return;
    }

    // Update payment status
    await this.repository.updatePaymentStatus(
      payment.business_id,
      payment.id,
      {
        status: PaymentStatus.SUCCESS,
        method: paymentEntity?.method ?? null,
        gatewayPaymentId: paymentEntity?.id ?? null,
        capturedAt: new Date(),
        gatewayResponse: webhookData.payload as unknown as Record<string, unknown>,
      },
    );

    // Emit payment.success
    const event: PaymentSuccessEvent = {
      type: 'payment.success',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: payment.business_id,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: paymentEntity?.id ?? '',
    };

    this.eventEmitter.emit('payment.success', event);

    this.logger.log(
      `Payment ${payment.id} marked SUCCESS via payment_link.paid webhook`,
    );
  }

  private async handlePaymentCaptured(
    webhookData: RazorpayWebhookPayload,
  ): Promise<void> {
    const paymentEntity = webhookData.payload.payment?.entity;

    if (!paymentEntity) {
      this.logger.warn('payment.captured webhook missing payment entity');
      return;
    }

    // Try to find payment by gateway payment ID first
    let payment = await this.repository.findPaymentByGatewayId(paymentEntity.id);

    // If not found by payment ID, try by order ID
    if (!payment && paymentEntity.order_id) {
      payment = await this.repository.findPaymentByGatewayOrderId(
        paymentEntity.order_id,
      );
    }

    if (!payment) {
      this.logger.warn(
        `No payment found for gateway payment ${paymentEntity.id}`,
      );
      return;
    }

    // Claim the transition in the database rather than deciding from the row
    // read above. `payment.authorized` and `payment.captured` are separate
    // events with separate idempotency keys, sent milliseconds apart for the
    // same payment, and the reconcile sweep can be settling it at the same
    // moment — so a pre-read check lets all of them through and `payment.success`
    // is emitted more than once for money collected once.
    const { claimed } = await this.repository.claimPaymentSuccess(
      payment.business_id,
      payment.id,
      {
        method: paymentEntity.method ?? null,
        gatewayPaymentId: paymentEntity.id,
        capturedAt: new Date(),
        gatewayResponse: webhookData.payload as unknown as Record<string, unknown>,
      },
    );

    if (!claimed) {
      this.logger.debug(
        `Payment ${payment.id} was already settled — skipping duplicate success event`,
      );
      return;
    }

    const event: PaymentSuccessEvent = {
      type: 'payment.success',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: payment.business_id,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: paymentEntity.id,
    };

    this.eventEmitter.emit('payment.success', event);

    this.logger.log(
      `Payment ${payment.id} captured via webhook (gateway: ${paymentEntity.id})`,
    );
  }

  private async handlePaymentFailed(
    webhookData: RazorpayWebhookPayload,
  ): Promise<void> {
    const paymentEntity = webhookData.payload.payment?.entity;

    if (!paymentEntity) {
      this.logger.warn('payment.failed webhook missing payment entity');
      return;
    }

    let payment = await this.repository.findPaymentByGatewayId(paymentEntity.id);

    if (!payment && paymentEntity.order_id) {
      payment = await this.repository.findPaymentByGatewayOrderId(
        paymentEntity.order_id,
      );
    }

    if (!payment) {
      this.logger.warn(
        `No payment found for failed gateway payment ${paymentEntity.id}`,
      );
      return;
    }

    const failureReason =
      paymentEntity.error_description ?? paymentEntity.error_code ?? 'Payment failed';

    await this.repository.updatePaymentStatus(
      payment.business_id,
      payment.id,
      {
        status: PaymentStatus.FAILED,
        gatewayPaymentId: paymentEntity.id,
        failedAt: new Date(),
        failureReason,
        gatewayResponse: webhookData.payload as unknown as Record<string, unknown>,
      },
    );

    const event: PaymentFailedEvent = {
      type: 'payment.failed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: payment.business_id,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      reason: failureReason,
    };

    this.eventEmitter.emit('payment.failed', event);

    this.logger.log(
      `Payment ${payment.id} failed via webhook: ${failureReason}`,
    );
  }

  /**
   * Stripe `checkout.session.completed` → mark the matching payment SUCCESS.
   * The Checkout Session id is stored in payment_link_id at creation time.
   */
  private async handleStripeCheckoutCompleted(
    event: StripeWebhookEvent,
  ): Promise<void> {
    const session = event.data.object;

    const payment = await this.repository.findPaymentByLinkId(session.id);
    if (!payment) {
      this.logger.warn(`No payment found for Stripe session ${session.id}`);
      return;
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      this.logger.debug(`Payment ${payment.id} already SUCCESS — skipping Stripe webhook`);
      return;
    }

    const paymentIntentId = session.payment_intent ?? null;
    const method = session.payment_method_types?.[0] ?? null;

    await this.repository.updatePaymentStatus(payment.business_id, payment.id, {
      status: PaymentStatus.SUCCESS,
      method,
      gatewayPaymentId: paymentIntentId,
      capturedAt: new Date(),
      gatewayResponse: event as unknown as Record<string, unknown>,
    });

    const successEvent: PaymentSuccessEvent = {
      type: 'payment.success',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: payment.business_id,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: paymentIntentId ?? '',
    };

    this.eventEmitter.emit('payment.success', successEvent);

    this.logger.log(
      `Payment ${payment.id} marked SUCCESS via Stripe checkout.session.completed`,
    );
  }

  /**
   * Stripe `checkout.session.expired` → mark the payment EXPIRED.
   */
  private async handleStripeCheckoutExpired(
    event: StripeWebhookEvent,
  ): Promise<void> {
    const session = event.data.object;
    const payment = await this.repository.findPaymentByLinkId(session.id);
    if (!payment) {
      return;
    }
    if (
      payment.status === PaymentStatus.SUCCESS ||
      payment.status === PaymentStatus.EXPIRED
    ) {
      return;
    }
    await this.repository.updatePaymentStatus(payment.business_id, payment.id, {
      status: PaymentStatus.EXPIRED,
      failedAt: new Date(),
      failureReason: 'Stripe checkout session expired',
    });
    this.logger.log(`Payment ${payment.id} marked EXPIRED via Stripe webhook`);
  }

  /**
   * Stripe `payment_intent.payment_failed` → mark the payment FAILED if we can
   * locate it by the PaymentIntent id.
   */
  private async handleStripePaymentFailed(
    event: StripeWebhookEvent,
  ): Promise<void> {
    const intent = event.data.object;
    const payment = await this.repository.findPaymentByGatewayId(intent.id);
    if (!payment) {
      this.logger.warn(`No payment found for Stripe PaymentIntent ${intent.id}`);
      return;
    }

    const failureReason =
      intent.last_payment_error?.message ??
      intent.last_payment_error?.code ??
      'Payment failed';

    await this.repository.updatePaymentStatus(payment.business_id, payment.id, {
      status: PaymentStatus.FAILED,
      failedAt: new Date(),
      failureReason,
      gatewayResponse: event as unknown as Record<string, unknown>,
    });

    const failedEvent: PaymentFailedEvent = {
      type: 'payment.failed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: payment.business_id,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      reason: failureReason,
    };

    this.eventEmitter.emit('payment.failed', failedEvent);

    this.logger.log(`Payment ${payment.id} failed via Stripe webhook: ${failureReason}`);
  }

  /**
   * Mark a payment SUCCESS during reconciliation and emit `payment.success`.
   * Shared by the Razorpay and Stripe reconciliation paths.
   */
  private async markReconciledSuccess(
    payment: payments,
    gatewayPaymentId: string | null,
  ): Promise<void> {
    // Same claim as the webhook path. Reconciliation runs precisely when a
    // webhook looks late, so it is the caller most likely to be racing one.
    const { claimed } = await this.repository.claimPaymentSuccess(
      payment.business_id,
      payment.id,
      { gatewayPaymentId, capturedAt: new Date() },
    );

    if (!claimed) {
      this.logger.debug(
        `Payment ${payment.id} was already settled by the webhook — reconcile is a no-op`,
      );
      return;
    }

    const event: PaymentSuccessEvent = {
      type: 'payment.success',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: payment.business_id,
      correlationId: generateCorrelationId(),
      paymentId: payment.id,
      orderId: payment.order_id ?? undefined,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      status: PaymentStatus.SUCCESS,
      gatewayPaymentId: gatewayPaymentId ?? '',
    };

    this.eventEmitter.emit('payment.success', event);

    this.logger.log(
      `Payment ${payment.id} reconciled to SUCCESS (gateway: ${gatewayPaymentId ?? 'n/a'})`,
    );
  }

  /**
   * Razorpay `refund.processed` → mark our refund record COMPLETED and roll
   * the parent payment to REFUNDED (fully) or PARTIALLY_REFUNDED, mirroring
   * what `getPaymentSummaryForOrder` / `getPaymentStats` expect to find.
   */
  private async handleRefundProcessed(
    webhookData: RazorpayWebhookPayload,
  ): Promise<void> {
    const refundEntity = webhookData.payload.refund?.entity;

    if (!refundEntity) {
      this.logger.warn('refund.processed webhook missing refund entity');
      return;
    }

    const refund = await this.repository.findRefundByGatewayId(refundEntity.id);

    if (!refund) {
      this.logger.warn(
        `No refund found for gateway refund ${refundEntity.id} (payment ${refundEntity.payment_id})`,
      );
      return;
    }

    if (refund.status === RefundStatus.COMPLETED) {
      this.logger.debug(
        `Refund ${refund.id} already COMPLETED — skipping refund.processed webhook`,
      );
      return;
    }

    await this.repository.updateRefundStatus(refund.business_id, refund.id, {
      status: RefundStatus.COMPLETED,
      gatewayResponse: webhookData.payload as unknown as Record<string, unknown>,
      completedAt: new Date(),
    });

    const payment = await this.repository.getPayment(refund.business_id, refund.payment_id);
    if (payment) {
      const originalAmountPaise = currencyToPaise(Number(payment.amount));
      const totalRefundedRupees = await this.repository.sumCompletedRefundsForPayment(
        refund.business_id,
        refund.payment_id,
      );
      const totalRefundedPaise = currencyToPaise(totalRefundedRupees);
      const newPaymentStatus =
        totalRefundedPaise >= originalAmountPaise
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;

      if (payment.status !== newPaymentStatus) {
        await this.repository.updatePaymentStatus(refund.business_id, payment.id, {
          status: newPaymentStatus,
        });
      }
    }

    const event: PaymentRefundEvent = {
      type: 'payment.refund.completed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId: refund.business_id,
      correlationId: generateCorrelationId(),
      refundId: refund.id,
      paymentId: refund.payment_id,
      orderId: refund.order_id ?? undefined,
      clientId: payment?.client_id ?? '',
      amountPaise: currencyToPaise(Number(refund.amount)),
      currency: refund.currency,
      reason: refund.reason ?? undefined,
    };

    this.eventEmitter.emit('payment.refund.completed', event);

    this.logger.log(
      `Refund ${refund.id} marked COMPLETED via Razorpay refund.processed webhook (gateway: ${refundEntity.id})`,
    );
  }

  // ─────────────────────────────────────────────
  // Private: Helpers
  // ─────────────────────────────────────────────

  /**
   * Derive the idempotency key for a Razorpay webhook.
   *
   * This key is the whole of our replay defence: `recordWebhookEvent` writes it
   * to `webhook_events.external_id` under a unique constraint, and anything
   * that collides with an existing row is discarded unprocessed. So the key has
   * to name *the thing the event happened to* — nothing coarser.
   *
   * Razorpay sends every entity an event touches, not just its subject. A
   * `refund.processed` payload carries `payload.refund` **and**
   * `payload.payment` (its `contains` array lists both), and a
   * `payment_link.paid` carries the link and the payment that settled it.
   * Reaching for `payload.payment.entity.id` first therefore keyed a refund on
   * the *payment* it came from: two partial refunds against one payment both
   * derived `refund.processed_pay_XXX`, the second was written off as a
   * duplicate, and that refund stayed PENDING forever with no
   * `payment.refund.completed` ever emitted — money the customer was told had
   * been returned, and no error anywhere to say otherwise.
   *
   * The event name already says which entity is the subject: everything before
   * the first `.` is Razorpay's entity namespace (`refund.processed` →
   * `refund`). Use that entity's id, and fall back most-specific-first only
   * when the namespace is one we do not know.
   */
  private deriveWebhookExternalId(data: RazorpayWebhookPayload): string {
    const event = data.event ?? 'unknown';
    const entities = data.payload ?? {};

    const refundId = entities.refund?.entity?.id;
    const paymentId = entities.payment?.entity?.id;
    const linkId = entities.payment_link?.entity?.id;

    const subject =
      event.split('.')[0] === 'refund'
        ? refundId
        : event.split('.')[0] === 'payment_link'
          ? linkId
          : event.split('.')[0] === 'payment'
            ? paymentId
            : undefined;

    const entityId = subject ?? refundId ?? paymentId ?? linkId;
    if (entityId) return `${event}_${entityId}`;

    // No entity we recognise. A constant here (this was `'unknown'`) is worse
    // than useless: the first such event claims `${event}_unknown` and every
    // later one of that type — a different order, a different subscription —
    // collides with it and is silently dropped for the life of the row. A
    // digest of the payload keeps genuine redeliveries (identical bytes)
    // deduping while letting distinct events through.
    return `${event}_${this.payloadDigest(data)}`;
  }

  /** Short, stable content digest — the last-resort idempotency key. */
  private payloadDigest(data: RazorpayWebhookPayload): string {
    return createHash('sha256')
      .update(JSON.stringify(data.payload ?? {}))
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Map a payment record to PaymentLinkDto.
   */
  private toPaymentLinkDto(payment: payments): PaymentLinkDto {
    return {
      id: payment.id,
      orderId: payment.order_id,
      clientId: payment.client_id,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      gateway: payment.gateway,
      status: payment.status,
      paymentLinkUrl: payment.payment_link_url,
      paymentLinkId: payment.payment_link_id,
      expiresAt: payment.payment_link_expires_at?.toISOString() ?? null,
      createdAt: payment.created_at.toISOString(),
    };
  }

  /**
   * Map a payment record to TransactionDto.
   */
  private toTransactionDto(payment: payments): TransactionDto {
    return {
      id: payment.id,
      businessId: payment.business_id,
      orderId: payment.order_id,
      clientId: payment.client_id,
      status: payment.status,
      method: payment.method,
      gateway: payment.gateway,
      amountPaise: currencyToPaise(Number(payment.amount)),
      currency: payment.currency,
      gatewayOrderId: payment.gateway_order_id,
      gatewayPaymentId: payment.gateway_payment_id,
      paymentLinkUrl: payment.payment_link_url,
      paymentLinkId: payment.payment_link_id,
      expiresAt: payment.payment_link_expires_at?.toISOString() ?? null,
      initiatedAt: payment.initiated_at?.toISOString() ?? null,
      capturedAt: payment.captured_at?.toISOString() ?? null,
      failedAt: payment.failed_at?.toISOString() ?? null,
      failureReason: payment.failure_reason,
      createdAt: payment.created_at.toISOString(),
      updatedAt: payment.updated_at.toISOString(),
    };
  }

  /**
   * Map a refund record to RefundDto.
   */
  private toRefundDto(refund: refunds): RefundDto {
    return {
      id: refund.id,
      paymentId: refund.payment_id,
      orderId: refund.order_id,
      amountPaise: currencyToPaise(Number(refund.amount)),
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason,
      requiresApproval: refund.requires_approval,
      gatewayRefundId: refund.gateway_refund_id,
      createdAt: refund.created_at.toISOString(),
    };
  }
}
