import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { ExternalServiceError } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────

export interface RazorpayPaymentLinkOptions {
  /** Amount in paise (integer) */
  amountPaise: number;
  currency: string;
  description?: string;
  /** Customer details for Razorpay link */
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  /** Link expiry timestamp (Unix epoch seconds) */
  expireBy?: number;
  /** Reference ID to map back to internal records */
  referenceId?: string;
  /** Callback URL on payment completion */
  callbackUrl?: string;
  /** Notes attached to the Razorpay entity */
  notes?: Record<string, string>;
}

export interface RazorpayPaymentLinkResult {
  /** Razorpay payment link ID (e.g. plink_xxx) */
  id: string;
  /** Short URL for the payment link */
  shortUrl: string;
  /** Full URL for the payment link */
  url: string;
  /** Razorpay status */
  status: string;
  /** Amount in paise */
  amountPaise: number;
}

export interface RazorpayRefundResult {
  /** Razorpay refund ID (e.g. rfnd_xxx) */
  id: string;
  /** Payment ID this refund is for */
  paymentId: string;
  /** Amount refunded in paise */
  amountPaise: number;
  /** Refund status */
  status: string;
}

/**
 * Interface for Razorpay gateway operations.
 * Implementations can be swapped for testing (mock) vs production (real SDK).
 */
export interface RazorpayPaymentLinkStatus {
  /** Razorpay payment link ID (e.g. plink_xxx) */
  id: string;
  /** Razorpay status: created | paid | cancelled | expired */
  status: string;
  /** Amount paid so far, in paise */
  amountPaidPaise: number;
  /** The captured payment ID, if any */
  paymentId?: string;
}

export interface IRazorpayGateway {
  createPaymentLink(options: RazorpayPaymentLinkOptions): Promise<RazorpayPaymentLinkResult>;
  createRefund(paymentId: string, amountPaise: number): Promise<RazorpayRefundResult>;
  fetchPaymentLinkStatus(paymentLinkId: string): Promise<RazorpayPaymentLinkStatus>;
  verifyWebhookSignature(payload: string | Buffer, signature: string): boolean;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

/**
 * RazorpayService — gateway integration for payment links, refunds,
 * and webhook signature verification.
 *
 * Credentials are sourced from ConfigService (never hardcoded).
 * In tests, inject a mock implementing IRazorpayGateway.
 */
@Injectable()
export class RazorpayService implements IRazorpayGateway {
  private readonly logger = new Logger(RazorpayService.name);

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl = 'https://api.razorpay.com/v1';

  constructor(private readonly configService: ConfigService) {
    this.keyId = this.configService.get<string>('RAZORPAY_KEY_ID', '');
    this.keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET', '');
    this.webhookSecret = this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET', '');

    if (!this.keyId || !this.keySecret) {
      this.logger.warn(
        'Razorpay credentials not configured. Payment operations will fail.',
      );
    }
  }

  /**
   * Create a Razorpay payment link.
   * Uses the Payment Links API (POST /v1/payment_links).
   */
  async createPaymentLink(
    options: RazorpayPaymentLinkOptions,
  ): Promise<RazorpayPaymentLinkResult> {
    const body = {
      amount: options.amountPaise,
      currency: options.currency,
      description: options.description ?? 'Payment',
      customer: options.customer ?? {},
      expire_by: options.expireBy,
      reference_id: options.referenceId,
      callback_url: options.callbackUrl,
      callback_method: 'get',
      notes: options.notes ?? {},
    };

    const response = await this.makeRequest<{
      id: string;
      short_url: string;
      url?: string;
      status: string;
      amount: number;
    }>('POST', '/payment_links', body);

    return {
      id: response.id,
      shortUrl: response.short_url,
      url: response.url ?? response.short_url,
      status: response.status,
      amountPaise: response.amount,
    };
  }

  /**
   * Create a refund against a Razorpay payment.
   * Uses the Refunds API (POST /v1/payments/:id/refund).
   */
  async createRefund(
    paymentId: string,
    amountPaise: number,
  ): Promise<RazorpayRefundResult> {
    const body = {
      amount: amountPaise,
    };

    const response = await this.makeRequest<{
      id: string;
      payment_id: string;
      amount: number;
      status: string;
    }>('POST', `/payments/${paymentId}/refund`, body);

    return {
      id: response.id,
      paymentId: response.payment_id,
      amountPaise: response.amount,
      status: response.status,
    };
  }

  /**
   * Fetch the current status of a payment link — used for reconciliation.
   * Uses the Payment Links API (GET /v1/payment_links/:id).
   */
  async fetchPaymentLinkStatus(
    paymentLinkId: string,
  ): Promise<RazorpayPaymentLinkStatus> {
    const response = await this.makeRequest<{
      id: string;
      status: string;
      amount_paid: number;
      payments?: Array<{ payment_id: string; status: string }>;
    }>('GET', `/payment_links/${paymentLinkId}`);

    const capturedPayment = response.payments?.find(
      (p) => p.status === 'captured',
    );

    return {
      id: response.id,
      status: response.status,
      amountPaidPaise: response.amount_paid ?? 0,
      paymentId: capturedPayment?.payment_id,
    };
  }

  /**
   * Verify Razorpay webhook signature using HMAC-SHA256.
   *
   * CRITICAL: This MUST be called before processing any webhook payload.
   * The signature is computed over the raw body using the webhook secret.
   */
  verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
  ): boolean {
    if (!this.webhookSecret) {
      this.logger.error(
        'RAZORPAY_WEBHOOK_SECRET not configured — cannot verify webhook signature',
      );
      return false;
    }

    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8');
      const expectedSignature = createHmac('sha256', this.webhookSecret)
        .update(payloadStr)
        .digest('hex');

      // Constant-time comparison to prevent timing attacks
      const sigBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }

      // Use timingSafeEqual for constant-time comparison
      return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch (error) {
      this.logger.error(
        `Webhook signature verification error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Make an authenticated HTTP request to Razorpay API.
   * Uses HTTP Basic Auth with key_id:key_secret.
   */
  private async makeRequest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    this.logger.debug(`Razorpay API: ${method} ${path}`);

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `Razorpay API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
      throw new ExternalServiceError('Razorpay', `API error ${response.statusText}`, {
        status: response.status,
        context: { body: errorBody },
      });
    }

    return response.json() as Promise<T>;
  }
}
