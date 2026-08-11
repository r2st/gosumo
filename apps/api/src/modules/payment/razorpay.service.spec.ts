/**
 * RazorpayService unit tests.
 *
 * `verifyWebhookSignature` is the security boundary for every inbound Razorpay
 * event — root rule #3 — and it is the reason this file exists. It has four
 * ways to return `false` (no secret configured, length mismatch, digest
 * mismatch, malformed input) and exactly one way to return `true`. A refactor
 * that turned any of those rejections into an accept would let anyone confirm
 * an arbitrary payment, and nothing else in the suite was covering it.
 *
 * The rest is HTTP plumbing, tested through a mocked `global.fetch` — the
 * service talks to the REST API directly rather than through an SDK.
 */

import { createHmac } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@gosumo/shared';

import { RazorpayService } from './razorpay.service';

const KEY_ID = 'rzp_test_key';
const KEY_SECRET = 'rzp_test_secret';
const WEBHOOK_SECRET = 'whsec_test';

describe('RazorpayService', () => {
  let fetchMock: jest.Mock;

  function build(
    overrides: Record<string, string> = {},
  ): { service: RazorpayService; error: jest.SpyInstance } {
    const values: Record<string, string> = {
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string, fallback: string) => values[key] ?? fallback),
    };

    const service = new RazorpayService(config as unknown as ConfigService);

    return {
      service,
      error: jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined),
    };
  }

  /** Construct with the given config, capturing what the constructor logged. */
  function constructWith(values: Record<string, string>): jest.SpyInstance {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const config = {
      get: jest.fn((key: string, fallback: string) => values[key] ?? fallback),
    };

    new RazorpayService(config as unknown as ConfigService);

    return warn;
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function jsonOk(payload: unknown): {
    ok: true;
    json: () => Promise<unknown>;
  } {
    return { ok: true, json: () => Promise.resolve(payload) };
  }

  // ─────────────────────────────────────────────
  // Credentials
  // ─────────────────────────────────────────────

  describe('credentials', () => {
    it('warns when the key id is missing', () => {
      const warn = constructWith({ RAZORPAY_KEY_SECRET: KEY_SECRET });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('credentials not configured'),
      );
    });

    it('warns when the key secret is missing', () => {
      const warn = constructWith({ RAZORPAY_KEY_ID: KEY_ID });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('credentials not configured'),
      );
    });

    it('stays quiet when both credentials are present', () => {
      const warn = constructWith({
        RAZORPAY_KEY_ID: KEY_ID,
        RAZORPAY_KEY_SECRET: KEY_SECRET,
      });

      expect(warn).not.toHaveBeenCalled();
    });

    it('authenticates with HTTP basic auth over key id and secret', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk({ id: 'plink_1', short_url: 'u', status: 'created', amount: 100 }));

      await service.createPaymentLink({ amountPaise: 100, currency: 'INR' });

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
      );
    });
  });

  // ─────────────────────────────────────────────
  // createPaymentLink
  // ─────────────────────────────────────────────

  describe('createPaymentLink', () => {
    const RESPONSE = {
      id: 'plink_1',
      short_url: 'https://rzp.io/i/abc',
      status: 'created',
      amount: 250000,
    };

    it('posts to the payment links endpoint', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk(RESPONSE));

      await service.createPaymentLink({ amountPaise: 250000, currency: 'INR' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.razorpay.com/v1/payment_links');
      expect(init.method).toBe('POST');
    });

    it('sends the amount in paise, unconverted', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk(RESPONSE));

      await service.createPaymentLink({ amountPaise: 250000, currency: 'INR' });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        amount: 250000,
        currency: 'INR',
      });
    });

    it('maps the gateway response onto the result shape', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(
        jsonOk({ ...RESPONSE, url: 'https://rzp.io/full/abc' }),
      );

      await expect(
        service.createPaymentLink({ amountPaise: 250000, currency: 'INR' }),
      ).resolves.toEqual({
        id: 'plink_1',
        shortUrl: 'https://rzp.io/i/abc',
        url: 'https://rzp.io/full/abc',
        status: 'created',
        amountPaise: 250000,
      });
    });

    it('falls back to the short URL when no full URL is returned', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk(RESPONSE));

      const result = await service.createPaymentLink({
        amountPaise: 250000,
        currency: 'INR',
      });

      expect(result.url).toBe('https://rzp.io/i/abc');
    });

    it('defaults the description', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk(RESPONSE));

      await service.createPaymentLink({ amountPaise: 100, currency: 'INR' });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).description).toBe(
        'Payment',
      );
    });

    it('defaults customer and notes to empty objects', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk(RESPONSE));

      await service.createPaymentLink({ amountPaise: 100, currency: 'INR' });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.customer).toEqual({});
      expect(body.notes).toEqual({});
    });

    it('passes through customer, notes, expiry, reference and callback', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk(RESPONSE));

      await service.createPaymentLink({
        amountPaise: 100,
        currency: 'INR',
        description: 'Order #12',
        customer: { name: 'Ramesh', phone: '+919876543210' },
        expireBy: 1800000000,
        referenceId: 'ord-12',
        callbackUrl: 'https://api.test/callback',
        notes: { orderId: 'ord-12' },
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        amount: 100,
        currency: 'INR',
        description: 'Order #12',
        customer: { name: 'Ramesh', phone: '+919876543210' },
        expire_by: 1800000000,
        reference_id: 'ord-12',
        callback_url: 'https://api.test/callback',
        callback_method: 'get',
        notes: { orderId: 'ord-12' },
      });
    });
  });

  // ─────────────────────────────────────────────
  // createRefund
  // ─────────────────────────────────────────────

  describe('createRefund', () => {
    it('posts the amount to the payment refund endpoint', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(
        jsonOk({
          id: 'rfnd_1',
          payment_id: 'pay_1',
          amount: 5000,
          status: 'processed',
        }),
      );

      await expect(service.createRefund('pay_1', 5000)).resolves.toEqual({
        id: 'rfnd_1',
        paymentId: 'pay_1',
        amountPaise: 5000,
        status: 'processed',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
      expect(JSON.parse(init.body)).toEqual({ amount: 5000 });
    });
  });

  // ─────────────────────────────────────────────
  // fetchPaymentLinkStatus
  // ─────────────────────────────────────────────

  describe('fetchPaymentLinkStatus', () => {
    it('fetches without a request body', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(
        jsonOk({ id: 'plink_1', status: 'created', amount_paid: 0 }),
      );

      await service.fetchPaymentLinkStatus('plink_1');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.razorpay.com/v1/payment_links/plink_1');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('surfaces the captured payment id', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(
        jsonOk({
          id: 'plink_1',
          status: 'paid',
          amount_paid: 250000,
          payments: [
            { payment_id: 'pay_failed', status: 'failed' },
            { payment_id: 'pay_ok', status: 'captured' },
          ],
        }),
      );

      await expect(
        service.fetchPaymentLinkStatus('plink_1'),
      ).resolves.toEqual({
        id: 'plink_1',
        status: 'paid',
        amountPaidPaise: 250000,
        paymentId: 'pay_ok',
      });
    });

    it('reports no payment id when none was captured', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(
        jsonOk({
          id: 'plink_1',
          status: 'created',
          amount_paid: 0,
          payments: [{ payment_id: 'pay_failed', status: 'failed' }],
        }),
      );

      const result = await service.fetchPaymentLinkStatus('plink_1');

      expect(result.paymentId).toBeUndefined();
    });

    it('reports no payment id when the payments array is absent', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(
        jsonOk({ id: 'plink_1', status: 'created', amount_paid: 0 }),
      );

      const result = await service.fetchPaymentLinkStatus('plink_1');

      expect(result.paymentId).toBeUndefined();
    });

    it('normalises a missing paid amount to zero', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue(jsonOk({ id: 'plink_1', status: 'created' }));

      const result = await service.fetchPaymentLinkStatus('plink_1');

      expect(result.amountPaidPaise).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────

  describe('API errors', () => {
    it('throws with the status when the gateway rejects the request', async () => {
      const { service } = build();
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('{"error":"invalid amount"}'),
      });

      const error = await service.createPaymentLink({ amountPaise: -1, currency: 'INR' }).then(
        () => null,
        (err: unknown) => err,
      );

      // The status moved from the message into the context, and with it the
      // retry decision: a 400 will fail identically forever.
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe('Razorpay: API error Bad Request');
      expect((error as ExternalServiceError).retryable).toBe(false);
      expect((error as ExternalServiceError).context).toMatchObject({
        service: 'Razorpay',
        status: 400,
      });
    });

    it('logs the gateway error body', async () => {
      const { service, error } = build();
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('bad key'),
      });

      await expect(service.createRefund('pay_1', 100)).rejects.toThrow();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('bad key'));
    });
  });

  // ─────────────────────────────────────────────
  // Webhook signature verification
  // ─────────────────────────────────────────────

  describe('verifyWebhookSignature', () => {
    const PAYLOAD = '{"event":"payment.captured","id":"evt_1"}';

    function sign(payload: string, secret = WEBHOOK_SECRET): string {
      return createHmac('sha256', secret).update(payload).digest('hex');
    }

    it('accepts a correctly signed payload', () => {
      const { service } = build();

      expect(
        service.verifyWebhookSignature(PAYLOAD, sign(PAYLOAD)),
      ).toBe(true);
    });

    it('accepts a correctly signed raw Buffer body', () => {
      // The webhook route verifies against req.rawBody, which is a Buffer.
      const { service } = build();

      expect(
        service.verifyWebhookSignature(Buffer.from(PAYLOAD, 'utf8'), sign(PAYLOAD)),
      ).toBe(true);
    });

    it('rejects a payload signed with the wrong secret', () => {
      const { service } = build();

      expect(
        service.verifyWebhookSignature(PAYLOAD, sign(PAYLOAD, 'attacker')),
      ).toBe(false);
    });

    it('rejects a tampered payload', () => {
      const { service } = build();
      const signature = sign(PAYLOAD);

      expect(
        service.verifyWebhookSignature(
          '{"event":"payment.captured","id":"evt_2"}',
          signature,
        ),
      ).toBe(false);
    });

    it('rejects a signature of the wrong length', () => {
      const { service } = build();

      expect(service.verifyWebhookSignature(PAYLOAD, 'abcd')).toBe(false);
    });

    it('rejects an empty signature', () => {
      const { service } = build();

      expect(service.verifyWebhookSignature(PAYLOAD, '')).toBe(false);
    });

    it('fails closed when no webhook secret is configured', () => {
      const { service, error } = build({ RAZORPAY_WEBHOOK_SECRET: '' });

      expect(service.verifyWebhookSignature(PAYLOAD, sign(PAYLOAD))).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('RAZORPAY_WEBHOOK_SECRET not configured'),
      );
    });

    it('fails closed on a malformed signature input', () => {
      const { service, error } = build();

      expect(
        service.verifyWebhookSignature(
          PAYLOAD,
          null as unknown as string,
        ),
      ).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('verification error'),
      );
    });

    it('fails closed when the raw body cannot be decoded', () => {
      const { service, error } = build();
      const hostileBody = {
        toString: () => {
          throw new Error('decode failed');
        },
      } as unknown as Buffer;

      expect(service.verifyWebhookSignature(hostileBody, sign(PAYLOAD))).toBe(
        false,
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('decode failed'),
      );
    });

    it('fails closed when the raw body throws a non-Error on read', () => {
      // Defensive: the catch stringifies whatever was thrown rather than
      // assuming an Error, so a body that rejects decoding still fails closed.
      const { service, error } = build();
      const hostileBody = {
        toString: () => {
          throw 'not an Error';
        },
      } as unknown as Buffer;

      expect(
        service.verifyWebhookSignature(hostileBody, sign(PAYLOAD)),
      ).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('not an Error'),
      );
    });

    it('does not accept a signature that merely prefixes the expected one', () => {
      const { service } = build();
      const signature = sign(PAYLOAD);

      expect(
        service.verifyWebhookSignature(PAYLOAD, signature.slice(0, 32)),
      ).toBe(false);
    });
  });
});
