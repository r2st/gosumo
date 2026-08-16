import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { ExternalServiceError } from '@gosumo/shared';

import { fetchWithTimeout } from '../../common/utils/http-timeout.util';
import { CircuitBreaker } from '../../common/resilience/circuit-breaker';
import { CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker.registry';
import { STRIPE_BREAKER } from '../../common/resilience/circuit-breaker.constants';

// ─────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────

export interface StripeCheckoutOptions {
  /** Amount in the currency's minor unit (e.g. cents for USD) */
  amountMinor: number;
  /** ISO 4217 currency code, lowercased for Stripe (e.g. "usd") */
  currency: string;
  description?: string;
  /** Customer email pre-filled on the Stripe Checkout page */
  customerEmail?: string;
  /** Reference ID (our internal payment id) stored in client_reference_id */
  referenceId?: string;
  /** URL Stripe redirects to after a successful payment */
  successUrl?: string;
  /** URL Stripe redirects to if the customer cancels */
  cancelUrl?: string;
  /** Metadata attached to the Checkout Session */
  metadata?: Record<string, string>;
}

export interface StripeCheckoutResult {
  /** Checkout Session id (e.g. cs_test_xxx) */
  id: string;
  /** Hosted, shareable payment URL */
  url: string;
  /** Session status (open | complete | expired) */
  status: string;
  /** Amount in minor units */
  amountMinor: number;
  /** The PaymentIntent id, if already created */
  paymentIntentId?: string;
}

export interface StripeRefundResult {
  /** Refund id (e.g. re_xxx) */
  id: string;
  /** PaymentIntent the refund is against */
  paymentIntentId: string;
  /** Amount refunded in minor units */
  amountMinor: number;
  /** Refund status (succeeded | pending | failed | canceled) */
  status: string;
}

export interface StripeSessionStatus {
  id: string;
  /** Session status: open | complete | expired */
  status: string;
  /** Payment status: paid | unpaid | no_payment_required */
  paymentStatus: string;
  paymentIntentId?: string;
}

/**
 * Gateway abstraction for Stripe operations. Swap a mock for this interface
 * in tests; the production implementation talks to the real Stripe REST API.
 */
/**
 * A PaymentIntent as Stripe holds it, normalized for reconciliation.
 *
 * `amountMinor` is the intent's amount; `amountReceivedMinor` is what actually
 * settled. A succeeded intent has them equal; anything else is the partial or
 * failed-capture case that the local `SUCCESS` status would hide.
 */
export interface StripePaymentSnapshot {
  id: string;
  /** requires_payment_method | processing | succeeded | canceled | … */
  status: string;
  amountMinor: number;
  amountReceivedMinor: number;
  amountRefundedMinor: number;
  currency: string;
  disputed: boolean;
}

export interface StripeRefundSnapshot {
  id: string;
  paymentIntentId: string;
  /** pending | succeeded | failed | canceled | requires_action */
  status: string;
  amountMinor: number;
}

export interface StripeDispute {
  id: string;
  paymentIntentId: string;
  /** warning_needs_response | needs_response | under_review | won | lost | … */
  status: string;
  amountMinor: number;
  reason: string | null;
}

export interface IStripeGateway {
  createCheckoutSession(options: StripeCheckoutOptions): Promise<StripeCheckoutResult>;
  createRefund(paymentIntentId: string, amountMinor: number): Promise<StripeRefundResult>;
  fetchSessionStatus(sessionId: string): Promise<StripeSessionStatus>;
  fetchPaymentIntent(paymentIntentId: string): Promise<StripePaymentSnapshot>;
  fetchRefundsForPaymentIntent(paymentIntentId: string): Promise<StripeRefundSnapshot[]>;
  listDisputes(sinceEpochSeconds: number): Promise<StripeDispute[]>;
  verifyWebhookSignature(payload: string | Buffer, signatureHeader: string): boolean;
}

/** Max age (seconds) of a Stripe webhook timestamp before it is rejected. */
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * StripeService — the international payment fallback gateway.
 *
 * Used for non-INR currencies (Razorpay is the primary for India). Creates
 * Stripe Checkout Sessions as shareable payment links, processes refunds,
 * and verifies webhook signatures using Stripe's `t=...,v1=...` scheme.
 *
 * Credentials come from ConfigService — never hardcoded. The Stripe REST API
 * is form-encoded (application/x-www-form-urlencoded), so nested params are
 * flattened (e.g. `line_items[0][price_data][currency]`).
 */
@Injectable()
export class StripeService implements IStripeGateway {
  private readonly logger = new Logger(StripeService.name);

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl = 'https://api.stripe.com/v1';

  /** Guards every call to the Stripe REST API. See `common/resilience/`. */
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly configService: ConfigService,
    registry: CircuitBreakerRegistry,
  ) {
    this.breaker = registry.get(STRIPE_BREAKER);
    this.secretKey = this.configService.get<string>('STRIPE_SECRET_KEY', '');
    this.webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');

    if (!this.secretKey) {
      this.logger.warn(
        'Stripe credentials not configured. International payment operations will fail.',
      );
    }
  }

  /**
   * Create a Stripe Checkout Session for an ad-hoc amount and return its
   * hosted URL. Uses inline `price_data` so no pre-created Price is required.
   */
  async createCheckoutSession(
    options: StripeCheckoutOptions,
  ): Promise<StripeCheckoutResult> {
    const params: Record<string, string> = {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': options.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(options.amountMinor),
      'line_items[0][price_data][product_data][name]':
        options.description ?? 'Payment',
    };

    if (options.successUrl) {
      params['success_url'] = options.successUrl;
    }
    if (options.cancelUrl) {
      params['cancel_url'] = options.cancelUrl;
    }
    if (options.customerEmail) {
      params['customer_email'] = options.customerEmail;
    }
    if (options.referenceId) {
      params['client_reference_id'] = options.referenceId;
    }
    for (const [key, value] of Object.entries(options.metadata ?? {})) {
      params[`metadata[${key}]`] = value;
    }

    const response = await this.makeRequest<{
      id: string;
      url: string;
      status: string;
      amount_total: number | null;
      payment_intent: string | null;
    }>('POST', '/checkout/sessions', params);

    return {
      id: response.id,
      url: response.url,
      status: response.status,
      amountMinor: response.amount_total ?? options.amountMinor,
      paymentIntentId: response.payment_intent ?? undefined,
    };
  }

  /**
   * Create a refund against a Stripe PaymentIntent.
   */
  async createRefund(
    paymentIntentId: string,
    amountMinor: number,
  ): Promise<StripeRefundResult> {
    const params: Record<string, string> = {
      payment_intent: paymentIntentId,
      amount: String(amountMinor),
    };

    const response = await this.makeRequest<{
      id: string;
      payment_intent: string;
      amount: number;
      status: string;
    }>('POST', '/refunds', params);

    return {
      id: response.id,
      paymentIntentId: response.payment_intent,
      amountMinor: response.amount,
      status: response.status,
    };
  }

  /**
   * Fetch the current status of a Checkout Session — used for reconciliation.
   */
  async fetchSessionStatus(sessionId: string): Promise<StripeSessionStatus> {
    const response = await this.makeRequest<{
      id: string;
      status: string;
      payment_status: string;
      payment_intent: string | null;
    }>('GET', `/checkout/sessions/${sessionId}`);

    return {
      id: response.id,
      status: response.status,
      paymentStatus: response.payment_status,
      paymentIntentId: response.payment_intent ?? undefined,
    };
  }

  /**
   * Fetch a PaymentIntent as Stripe holds it — the reconciliation read.
   * Uses GET /v1/payment_intents/:id with the latest charge expanded, since
   * the refunded total and the dispute flag live on the charge, not the intent.
   */
  async fetchPaymentIntent(paymentIntentId: string): Promise<StripePaymentSnapshot> {
    const response = await this.makeRequest<{
      id: string;
      status: string;
      amount: number;
      amount_received?: number;
      currency: string;
      latest_charge?: {
        amount_refunded?: number;
        disputed?: boolean;
      } | null;
    }>('GET', `/payment_intents/${paymentIntentId}?expand[]=latest_charge`);

    return {
      id: response.id,
      status: response.status,
      amountMinor: response.amount,
      amountReceivedMinor: response.amount_received ?? 0,
      amountRefundedMinor: response.latest_charge?.amount_refunded ?? 0,
      currency: (response.currency ?? '').toUpperCase(),
      disputed: Boolean(response.latest_charge?.disputed),
    };
  }

  /**
   * Every refund Stripe holds against a PaymentIntent.
   * Uses GET /v1/refunds?payment_intent=…
   *
   * Plural for the same reason as the Razorpay side: partial refunds stack,
   * and a refund issued from the Stripe dashboard has no local row at all.
   */
  async fetchRefundsForPaymentIntent(
    paymentIntentId: string,
  ): Promise<StripeRefundSnapshot[]> {
    const response = await this.makeRequest<{
      data?: Array<{
        id: string;
        payment_intent?: string | null;
        status: string;
        amount: number;
      }>;
    }>('GET', `/refunds?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=100`);

    return (response.data ?? []).map((item) => ({
      id: item.id,
      paymentIntentId: item.payment_intent ?? paymentIntentId,
      status: item.status,
      amountMinor: item.amount,
    }));
  }

  /** Disputes created since an instant. Uses GET /v1/disputes. */
  async listDisputes(sinceEpochSeconds: number): Promise<StripeDispute[]> {
    const response = await this.makeRequest<{
      data?: Array<{
        id: string;
        payment_intent?: string | null;
        status: string;
        amount: number;
        reason?: string | null;
      }>;
    }>(
      'GET',
      `/disputes?created[gte]=${Math.floor(sinceEpochSeconds)}&limit=100`,
    );

    return (response.data ?? [])
      .filter((item): item is typeof item & { payment_intent: string } =>
        Boolean(item.payment_intent),
      )
      .map((item) => ({
        id: item.id,
        paymentIntentId: item.payment_intent,
        status: item.status,
        amountMinor: item.amount,
        reason: item.reason ?? null,
      }));
  }

  /**
   * Verify a Stripe webhook signature.
   *
   * Stripe sends a `Stripe-Signature` header like `t=123,v1=abc,v1=def`.
   * The signed payload is `${timestamp}.${rawBody}`; the expected signature is
   * HMAC-SHA256 of that payload keyed by the webhook secret. We also reject
   * timestamps older than the tolerance window to block replay attacks.
   *
   * CRITICAL: must be called before processing any webhook payload.
   */
  verifyWebhookSignature(
    payload: string | Buffer,
    signatureHeader: string,
  ): boolean {
    if (!this.webhookSecret) {
      this.logger.error(
        'STRIPE_WEBHOOK_SECRET not configured — cannot verify webhook signature',
      );
      return false;
    }

    if (!signatureHeader) {
      return false;
    }

    try {
      const parts = signatureHeader.split(',').map((p) => p.trim());
      let timestamp = '';
      const signatures: string[] = [];

      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 't' && value) {
          timestamp = value;
        } else if (key === 'v1' && value) {
          signatures.push(value);
        }
      }

      if (!timestamp || signatures.length === 0) {
        return false;
      }

      // Replay protection: reject stale timestamps.
      const timestampSeconds = parseInt(timestamp, 10);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (
        Number.isNaN(timestampSeconds) ||
        Math.abs(nowSeconds - timestampSeconds) > STRIPE_WEBHOOK_TOLERANCE_SECONDS
      ) {
        this.logger.warn('Stripe webhook timestamp outside tolerance window');
        return false;
      }

      const payloadStr =
        typeof payload === 'string' ? payload : payload.toString('utf8');
      const signedPayload = `${timestamp}.${payloadStr}`;
      const expected = createHmac('sha256', this.webhookSecret)
        .update(signedPayload)
        .digest('hex');
      const expectedBuffer = Buffer.from(expected, 'hex');

      // Stripe may send multiple v1 signatures; any match is valid.
      return signatures.some((sig) => {
        const sigBuffer = Buffer.from(sig, 'hex');
        return (
          sigBuffer.length === expectedBuffer.length &&
          timingSafeEqual(sigBuffer, expectedBuffer)
        );
      });
    } catch (error) {
      this.logger.error(
        `Stripe webhook signature verification error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Make an authenticated, form-encoded request to the Stripe REST API.
   * Auth is HTTP Basic with the secret key as the username.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    return this.breaker.run(() => this.sendRequest<T>(method, path, params));
  }

  private async sendRequest<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const auth = Buffer.from(`${this.secretKey}:`).toString('base64');

    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
    };

    const fetchOptions: RequestInit = { method, headers };

    if (params && method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        form.append(key, value);
      }
      fetchOptions.body = form.toString();
    }

    this.logger.debug(`Stripe API: ${method} ${path}`);

    const response = await fetchWithTimeout(url, fetchOptions, { service: 'Stripe' });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `Stripe API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
      throw new ExternalServiceError('Stripe', `API error ${response.statusText}`, {
        status: response.status,
        context: { body: errorBody },
      });
    }

    return response.json() as Promise<T>;
  }
}
