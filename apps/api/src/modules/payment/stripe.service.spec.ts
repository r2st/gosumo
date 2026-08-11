import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { ExternalServiceError } from '@gosumo/shared';
import { StripeService } from './stripe.service';

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

describe('StripeService', () => {
  let service: StripeService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    const mockConfig = {
      get: jest.fn((key: string, def?: unknown) => {
        if (key === 'STRIPE_SECRET_KEY') return SECRET_KEY;
        if (key === 'STRIPE_WEBHOOK_SECRET') return WEBHOOK_SECRET;
        return def;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<StripeService>(StripeService);
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

    it('should throw on a non-OK Stripe response', async () => {
      mockFetchOnce({ error: 'bad' }, false, 400);

      const error = await service.createCheckoutSession({ amountMinor: 100, currency: 'USD' }).then(
        () => null,
        (err: unknown) => err,
      );

      // A 400 means Stripe rejected the request itself — replaying it is
      // pointless, so the queue must not retry.
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe('Stripe: API error Error');
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
  });
});
