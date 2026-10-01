import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { ExternalServiceError } from '@gosumo/shared';
import { StripeService } from './stripe.service';
import { CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker.registry';

const SECRET_KEY = 'sk_test_dummy';
const WEBHOOK_SECRET = 'whsec_test_dummy';

function buildSignatureHeader(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  const signed = `${timestamp}.${payload}`;
  const sig = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/** Build a service against an arbitrary credential set. */
async function buildService(
  creds: { secretKey?: string; webhookSecret?: string } = {},
): Promise<StripeService> {
  const { secretKey = SECRET_KEY, webhookSecret = WEBHOOK_SECRET } = creds;
  const mockConfig = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'STRIPE_SECRET_KEY') return secretKey;
      if (key === 'STRIPE_WEBHOOK_SECRET') return webhookSecret;
      return def;
    }),
  };

  // A fresh registry per service, so the breaker one test trips does not
  // reject the next test's calls. In the app the registry is global and one
  // breaker is shared — see `common/resilience/resilience.module.ts`.
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      StripeService,
      { provide: ConfigService, useValue: mockConfig },
      { provide: CircuitBreakerRegistry, useFactory: () => new CircuitBreakerRegistry() },
    ],
  }).compile();

  return module.get<StripeService>(StripeService);
}

describe('StripeService', () => {
  let service: StripeService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    service = await buildService();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    jest.restoreAllMocks();
  });

  function mockFetchOnce(body: unknown, ok = true, status = 200): void {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response);
  }

  // ─────────────────────────────────────────────
  // Webhook signature verification
  // ─────────────────────────────────────────────

  describe('verifyWebhookSignature', () => {
    it('should accept a valid signature within the tolerance window', () => {
      const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
      const now = Math.floor(Date.now() / 1000);
      const header = buildSignatureHeader(payload, WEBHOOK_SECRET, now);

      expect(service.verifyWebhookSignature(payload, header)).toBe(true);
    });

    it('should reject a tampered payload', () => {
      const payload = JSON.stringify({ id: 'evt_1' });
      const now = Math.floor(Date.now() / 1000);
      const header = buildSignatureHeader(payload, WEBHOOK_SECRET, now);

      expect(
        service.verifyWebhookSignature('{"id":"evt_TAMPERED"}', header),
      ).toBe(false);
    });

    it('should reject a signature computed with the wrong secret', () => {
      const payload = JSON.stringify({ id: 'evt_1' });
      const now = Math.floor(Date.now() / 1000);
      const header = buildSignatureHeader(payload, 'whsec_wrong', now);

      expect(service.verifyWebhookSignature(payload, header)).toBe(false);
    });

    it('should reject a stale timestamp (replay protection)', () => {
      const payload = JSON.stringify({ id: 'evt_1' });
      const stale = Math.floor(Date.now() / 1000) - 10_000;
      const header = buildSignatureHeader(payload, WEBHOOK_SECRET, stale);

      expect(service.verifyWebhookSignature(payload, header)).toBe(false);
    });

    it('should reject an empty signature header', () => {
      expect(service.verifyWebhookSignature('{}', '')).toBe(false);
    });

    it('should reject a malformed signature header', () => {
      expect(service.verifyWebhookSignature('{}', 'garbage')).toBe(false);
    });

    it('should reject a header carrying a timestamp but no v1 signature', () => {
      const now = Math.floor(Date.now() / 1000);

      expect(service.verifyWebhookSignature('{}', `t=${now}`)).toBe(false);
    });

    it('should reject a header carrying a v1 signature but no timestamp', () => {
      // Without `t` there is nothing to bind the signature to, so the replay
      // window cannot be enforced — treat it as unsigned.
      expect(service.verifyWebhookSignature('{}', 'v1=abcdef')).toBe(false);
    });

    it('should reject a non-numeric timestamp', () => {
      const payload = '{}';
      const sig = createHmac('sha256', WEBHOOK_SECRET)
        .update(`not-a-number.${payload}`)
        .digest('hex');

      expect(
        service.verifyWebhookSignature(payload, `t=not-a-number,v1=${sig}`),
      ).toBe(false);
    });

    it('should accept when any one of several v1 signatures matches', () => {
      // Stripe sends multiple v1 values during a webhook-secret rotation; the
      // new secret's signature arrives alongside the old one.
      const payload = JSON.stringify({ id: 'evt_rotate' });
      const now = Math.floor(Date.now() / 1000);
      const valid = createHmac('sha256', WEBHOOK_SECRET)
        .update(`${now}.${payload}`)
        .digest('hex');

      expect(
        service.verifyWebhookSignature(payload, `t=${now},v1=deadbeef,v1=${valid}`),
      ).toBe(true);
    });

    it('should verify a Buffer raw body identically to a string', () => {
      // The controller hands us `req.rawBody`, which is a Buffer.
      const payload = JSON.stringify({ id: 'evt_buf' });
      const now = Math.floor(Date.now() / 1000);
      const header = buildSignatureHeader(payload, WEBHOOK_SECRET, now);

      expect(service.verifyWebhookSignature(Buffer.from(payload, 'utf8'), header)).toBe(
        true,
      );
    });

    it('should tolerate a timestamp slightly in the future (clock skew)', () => {
      const payload = '{}';
      const skewed = Math.floor(Date.now() / 1000) + 60;
      const header = buildSignatureHeader(payload, WEBHOOK_SECRET, skewed);

      expect(service.verifyWebhookSignature(payload, header)).toBe(true);
    });

    it('should reject a future timestamp beyond the tolerance window', () => {
      const payload = '{}';
      const future = Math.floor(Date.now() / 1000) + 10_000;
      const header = buildSignatureHeader(payload, WEBHOOK_SECRET, future);

      expect(service.verifyWebhookSignature(payload, header)).toBe(false);
    });

    it('should return false rather than throw when the body cannot be read', async () => {
      // A consumed/detached raw body throws on toString. Verification must fail
      // closed instead of propagating into the webhook controller.
      const hostile = {
        toString: () => {
          throw new Error('body already consumed');
        },
      } as unknown as Buffer;
      const now = Math.floor(Date.now() / 1000);

      expect(
        service.verifyWebhookSignature(hostile, `t=${now},v1=abcdef`),
      ).toBe(false);
    });

    it('should return false when the body throws a non-Error', async () => {
      const hostile = {
        toString: () => {
          throw 'detached buffer';
        },
      } as unknown as Buffer;
      const now = Math.floor(Date.now() / 1000);

      expect(service.verifyWebhookSignature(hostile, `t=${now},v1=abcdef`)).toBe(false);
    });

    it('should refuse every signature when STRIPE_WEBHOOK_SECRET is unset', async () => {
      const unconfigured = await buildService({ webhookSecret: '' });
      const payload = '{}';
      const now = Math.floor(Date.now() / 1000);
      // Even a header signed with the empty string must not pass.
      const header = buildSignatureHeader(payload, '', now);

      expect(unconfigured.verifyWebhookSignature(payload, header)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // Checkout session
  // ─────────────────────────────────────────────

  describe('createCheckoutSession', () => {
    it('should create a checkout session and map the response', async () => {
      mockFetchOnce({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        status: 'open',
        amount_total: 5000,
        payment_intent: null,
      });

      const result = await service.createCheckoutSession({
        amountMinor: 5000,
        currency: 'USD',
        description: 'Test order',
        customerEmail: 'buyer@example.com',
      });

      expect(result.id).toBe('cs_test_123');
      expect(result.url).toContain('checkout.stripe.com');
      expect(result.amountMinor).toBe(5000);

      // Verify the request was form-encoded with lowercase currency.
      const call = fetchSpy.mock.calls[0]!;
      const body = (call[1] as RequestInit).body as string;
      expect(body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd');
      expect(body).toContain('unit_amount%5D=5000');
    });

    it('should forward redirect URLs, the reference id, and metadata', async () => {
      mockFetchOnce({
        id: 'cs_test_full',
        url: 'https://checkout.stripe.com/c/pay/cs_test_full',
        status: 'open',
        amount_total: 9900,
        payment_intent: 'pi_test_full',
      });

      const result = await service.createCheckoutSession({
        amountMinor: 9900,
        currency: 'EUR',
        description: 'Annual plan',
        customerEmail: 'buyer@example.com',
        referenceId: 'pay_internal_1',
        successUrl: 'https://app.gosumo.test/paid',
        cancelUrl: 'https://app.gosumo.test/cancelled',
        metadata: { businessId: 'biz_1', orderId: 'ord_1' },
      });

      expect(result.paymentIntentId).toBe('pi_test_full');

      const body = new URLSearchParams(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.get('success_url')).toBe('https://app.gosumo.test/paid');
      expect(body.get('cancel_url')).toBe('https://app.gosumo.test/cancelled');
      expect(body.get('client_reference_id')).toBe('pay_internal_1');
      expect(body.get('customer_email')).toBe('buyer@example.com');
      expect(body.get('metadata[businessId]')).toBe('biz_1');
      expect(body.get('metadata[orderId]')).toBe('ord_1');
    });

    it('should omit optional fields entirely when they are not supplied', async () => {
      mockFetchOnce({
        id: 'cs_test_bare',
        url: 'https://checkout.stripe.com/c/pay/cs_test_bare',
        status: 'open',
        amount_total: null,
        payment_intent: null,
      });

      const result = await service.createCheckoutSession({
        amountMinor: 1500,
        currency: 'GBP',
      });

      // Stripe echoes no amount_total until the session is finalised, so the
      // requested amount is what we report back.
      expect(result.amountMinor).toBe(1500);
      expect(result.paymentIntentId).toBeUndefined();

      const body = new URLSearchParams(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.get('success_url')).toBeNull();
      expect(body.get('cancel_url')).toBeNull();
      expect(body.get('client_reference_id')).toBeNull();
      expect(body.get('customer_email')).toBeNull();
      expect(body.get('line_items[0][price_data][product_data][name]')).toBe('Payment');
    });

    it('should authenticate with the secret key as HTTP Basic username', async () => {
      mockFetchOnce({
        id: 'cs_test_auth',
        url: 'u',
        status: 'open',
        amount_total: 100,
        payment_intent: null,
      });

      await service.createCheckoutSession({ amountMinor: 100, currency: 'USD' });

      const headers = (fetchSpy.mock.calls[0]![1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`,
      );
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('should still attempt the call when no secret key is configured', async () => {
      // The constructor only warns; a misconfigured deployment fails at the
      // gateway (401) rather than silently pretending to have taken payment.
      const unconfigured = await buildService({ secretKey: '' });
      mockFetchOnce({ error: { message: 'Invalid API Key' } }, false, 401);

      await expect(
        unconfigured.createCheckoutSession({ amountMinor: 100, currency: 'USD' }),
      ).rejects.toBeInstanceOf(ExternalServiceError);
    });

    it('should throw on a non-OK Stripe response', async () => {
      mockFetchOnce({ error: 'bad' }, false, 400);

      const error = await service.createCheckoutSession({ amountMinor: 100, currency: 'USD' }).then(
        () => null,
        (err: unknown) => err,
      );

      // A 400 means Stripe rejected the request itself — replaying it is
      // pointless, so the queue must not retry.
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe('API error Error');
      expect((error as ExternalServiceError).retryable).toBe(false);
      expect((error as ExternalServiceError).context).toMatchObject({
        service: 'Stripe',
        status: 400,
      });
    });
  });

  // ─────────────────────────────────────────────
  // Refunds
  // ─────────────────────────────────────────────

  describe('createRefund', () => {
    it('should create a refund against a PaymentIntent', async () => {
      mockFetchOnce({
        id: 're_test_1',
        payment_intent: 'pi_test_1',
        amount: 2500,
        status: 'succeeded',
      });

      const result = await service.createRefund('pi_test_1', 2500);

      expect(result.id).toBe('re_test_1');
      expect(result.paymentIntentId).toBe('pi_test_1');
      expect(result.amountMinor).toBe(2500);
      expect(result.status).toBe('succeeded');
    });
  });

  // ─────────────────────────────────────────────
  // Session status (reconciliation)
  // ─────────────────────────────────────────────

  describe('fetchSessionStatus', () => {
    it('should map a session status response', async () => {
      mockFetchOnce({
        id: 'cs_test_123',
        status: 'complete',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
      });

      const result = await service.fetchSessionStatus('cs_test_123');

      expect(result.status).toBe('complete');
      expect(result.paymentStatus).toBe('paid');
      expect(result.paymentIntentId).toBe('pi_test_1');
    });

    it('should issue a GET with no form body', async () => {
      mockFetchOnce({
        id: 'cs_test_123',
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: null,
      });

      const result = await service.fetchSessionStatus('cs_test_123');

      expect(result.paymentIntentId).toBeUndefined();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_123');
      expect((init as RequestInit).method).toBe('GET');
      expect((init as RequestInit).body).toBeUndefined();
      expect(
        ((init as RequestInit).headers as Record<string, string>)['Content-Type'],
      ).toBeUndefined();
    });
  });
});
