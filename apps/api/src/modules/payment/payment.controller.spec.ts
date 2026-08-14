/**
 * PaymentController — the argument marshalling nothing else covers.
 *
 * The controller is thin, but two of its branches are the ones a payment
 * webhook's security depends on:
 *
 *  - **rawBody.** Signature verification must run against the exact bytes the
 *    gateway signed. `req.rawBody` is populated by `rawBody: true` in main.ts;
 *    the `Buffer.from(JSON.stringify(req.body))` fallback exists for the case
 *    where it is not, and re-serialising a parsed body will not reproduce the
 *    original bytes. The fallback must therefore still hand *something* to the
 *    verifier rather than crashing — the verifier is what rejects it.
 *
 *  - **A missing signature header** must reach the service as `''`, so the
 *    service performs its normal rejection, rather than arriving as
 *    `undefined` and risking a looser comparison.
 *
 * Plus the refund-list query coercion, where an absent page/limit must stay
 * `undefined` (let the service default) instead of becoming NaN.
 */
import { Test, TestingModule } from '@nestjs/testing';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';

const BIZ = '00000000-0000-4000-a000-000000000001';

describe('PaymentController', () => {
  let controller: PaymentController;
  let paymentService: {
    listRefunds: jest.Mock;
    handleRazorpayWebhook: jest.Mock;
    handleStripeWebhook: jest.Mock;
  };

  beforeEach(async () => {
    paymentService = {
      listRefunds: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      handleRazorpayWebhook: jest.fn().mockResolvedValue(undefined),
      handleStripeWebhook: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: InvoiceService, useValue: {} },
      ],
    }).compile();

    controller = module.get(PaymentController);
  });

  /** A request carrying the raw bytes the gateway signed. */
  function reqWithRawBody(raw: Buffer, body: unknown = {}): RawBodyRequest<Request> {
    return { rawBody: raw, body } as unknown as RawBodyRequest<Request>;
  }

  /** A request where the raw-body middleware did not populate `rawBody`. */
  function reqWithoutRawBody(body: unknown): RawBodyRequest<Request> {
    return { body } as unknown as RawBodyRequest<Request>;
  }

  describe('listRefunds query handling', () => {
    // These tests used to pin the controller's own string→number parsing, back
    // when page/limit arrived as bare `@Query()` strings. That parsing now
    // belongs to the global ValidationPipe via ListRefundsQueryDto — along with
    // the bounds it never had, which is what made `?limit=abc` a 500 and
    // `?page=0` a negative skip. What is left for the controller to get right
    // is forwarding the validated values and inventing nothing; the bounds
    // themselves are covered in pagination-bound-contract.spec.ts.
    const PAYMENT_ID = '00000000-0000-4000-b000-000000000001';
    const ORDER_ID = '00000000-0000-4000-c000-000000000001';

    it('leaves page and limit undefined when the caller omits them', async () => {
      await controller.listRefunds(BIZ, {});

      expect(paymentService.listRefunds).toHaveBeenCalledWith(BIZ, {
        paymentId: undefined,
        orderId: undefined,
        page: undefined,
        limit: undefined,
      });
    });

    it('forwards every supplied filter unchanged', async () => {
      await controller.listRefunds(BIZ, {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        page: 3,
        limit: 50,
      });

      expect(paymentService.listRefunds).toHaveBeenCalledWith(BIZ, {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        page: 3,
        limit: 50,
      });
    });

    it('forwards page and limit independently', async () => {
      await controller.listRefunds(BIZ, { page: 2 });
      expect(paymentService.listRefunds).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ page: 2, limit: undefined }),
      );

      await controller.listRefunds(BIZ, { limit: 10 });
      expect(paymentService.listRefunds).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ page: undefined, limit: 10 }),
      );
    });

    it('scopes the listing to the tenant from the token', async () => {
      await controller.listRefunds(BIZ, {});

      expect(paymentService.listRefunds.mock.calls[0][0]).toBe(BIZ);
    });
  });

  describe('Razorpay webhook', () => {
    it('passes the exact raw bytes and signature to the verifier', async () => {
      const raw = Buffer.from('{"event":"payment.captured"}');

      const result = await controller.handleRazorpayWebhook(reqWithRawBody(raw), 'sig-abc');

      expect(paymentService.handleRazorpayWebhook).toHaveBeenCalledWith(raw, 'sig-abc');
      expect(result).toEqual({ status: 'ok' });
    });

    it('falls back to the re-serialised body when rawBody is absent', async () => {
      const body = { event: 'payment.captured' };

      await controller.handleRazorpayWebhook(reqWithoutRawBody(body), 'sig-abc');

      const [passed] = paymentService.handleRazorpayWebhook.mock.calls[0];
      expect(Buffer.isBuffer(passed)).toBe(true);
      expect(passed.toString()).toBe(JSON.stringify(body));
    });

    it('sends an empty string rather than undefined when the signature header is missing', async () => {
      await controller.handleRazorpayWebhook(
        reqWithRawBody(Buffer.from('{}')),
        undefined as unknown as string,
      );

      expect(paymentService.handleRazorpayWebhook).toHaveBeenCalledWith(expect.any(Buffer), '');
    });

    it('does not swallow a verification failure', async () => {
      paymentService.handleRazorpayWebhook.mockRejectedValue(new Error('Invalid signature'));

      await expect(
        controller.handleRazorpayWebhook(reqWithRawBody(Buffer.from('{}')), 'bad'),
      ).rejects.toThrow('Invalid signature');
    });
  });

  describe('Stripe webhook', () => {
    it('passes the exact raw bytes and signature to the verifier', async () => {
      const raw = Buffer.from('{"type":"checkout.session.completed"}');

      const result = await controller.handleStripeWebhook(reqWithRawBody(raw), 'sig-xyz');

      expect(paymentService.handleStripeWebhook).toHaveBeenCalledWith(raw, 'sig-xyz');
      expect(result).toEqual({ received: true });
    });

    it('falls back to the re-serialised body when rawBody is absent', async () => {
      const body = { type: 'checkout.session.completed' };

      await controller.handleStripeWebhook(reqWithoutRawBody(body), 'sig-xyz');

      const [passed] = paymentService.handleStripeWebhook.mock.calls[0];
      expect(Buffer.isBuffer(passed)).toBe(true);
      expect(passed.toString()).toBe(JSON.stringify(body));
    });

    it('sends an empty string rather than undefined when the signature header is missing', async () => {
      await controller.handleStripeWebhook(
        reqWithRawBody(Buffer.from('{}')),
        undefined as unknown as string,
      );

      expect(paymentService.handleStripeWebhook).toHaveBeenCalledWith(expect.any(Buffer), '');
    });

    it('does not swallow a verification failure', async () => {
      paymentService.handleStripeWebhook.mockRejectedValue(new Error('Invalid signature'));

      await expect(
        controller.handleStripeWebhook(reqWithRawBody(Buffer.from('{}')), 'bad'),
      ).rejects.toThrow('Invalid signature');
    });
  });
});
