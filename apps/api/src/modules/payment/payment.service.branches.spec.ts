/**
 * PaymentService — the paths the main suite does not reach.
 *
 * Most of what is left is the **tenant resolver** that runs after a webhook
 * handler has already thrown. It exists so the dead-letter entry lands in the
 * right business's replay queue instead of a platform-wide bucket that nobody
 * owns, and it is the one piece of the payment module that runs exclusively
 * during a failure — so nothing else exercises it.
 *
 * Three properties matter there:
 *
 *  - It **tries every identifier in turn**. A Razorpay `refund.processed`
 *    event carries no `payment.entity`, so a resolver that stopped after the
 *    first miss would attribute every refund failure to nobody. Same for a
 *    Stripe event whose session is unknown but whose `payment_intent` is not.
 *  - It **never throws**. It runs inside the failure handler; if it threw, the
 *    original error would be replaced by a lookup error and the DLQ write
 *    would be skipped entirely — losing the webhook the mechanism exists to
 *    preserve.
 *  - It **never invents a tenant**. Unresolvable means `null`, not the first
 *    business it can find.
 *
 * The rest is the read-side plumbing: the list/stat verbs that only ever ran
 * through the controller.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { RazorpayService } from './razorpay.service';
import { StripeService } from './stripe.service';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import type { ListPaymentsQueryDto } from './dto';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS = '00000000-0000-4000-a000-0000000000ff';
const PAYMENT_ID = '00000000-0000-4000-a000-000000000003';
const ORDER_ID = '00000000-0000-4000-a000-000000000004';
const REFUND_ID = '00000000-0000-4000-a000-000000000005';

function makeRefundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    business_id: BUSINESS_ID,
    payment_id: PAYMENT_ID,
    order_id: ORDER_ID,
    status: 'INITIATED',
    amount: { toNumber: () => 250, toString: () => '250.00' },
    currency: 'INR',
    reason: 'Customer request',
    notes: null,
    gateway_refund_id: 'rfnd_1',
    gateway_response: {},
    requires_approval: false,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    initiated_at: new Date('2026-08-01T00:00:00Z'),
    completed_at: null,
    failed_at: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PaymentService (remaining branches)', () => {
  let service: PaymentService;
  let repository: Record<string, jest.Mock>;
  let razorpay: Record<string, jest.Mock>;
  let stripe: Record<string, jest.Mock>;
  let webhookDlq: { capture: jest.Mock; registerReplayer: jest.Mock };

  beforeEach(async () => {
    repository = {
      createPayment: jest.fn(),
      getPayment: jest.fn(),
      listPayments: jest.fn(),
      updatePaymentStatus: jest.fn(),
      findPaymentByGatewayId: jest.fn().mockResolvedValue(null),
      findPaymentByGatewayOrderId: jest.fn().mockResolvedValue(null),
      findPaymentByLinkId: jest.fn().mockResolvedValue(null),
      createRefund: jest.fn(),
      getRefund: jest.fn(),
      listRefunds: jest.fn(),
      updateRefundStatus: jest.fn(),
      findRefundByGatewayId: jest.fn().mockResolvedValue(null),
      sumCompletedRefundsForPayment: jest.fn(),
      sumCommittedRefundsForPayment: jest.fn(),
      getPaymentSummaryForOrder: jest.fn(),
      getPaymentStats: jest.fn(),
      recordWebhookEvent: jest.fn().mockResolvedValue({ id: 'wh-1' }),
      markWebhookProcessed: jest.fn().mockResolvedValue(undefined),
      listReconcilablePayments: jest.fn(),
    };
    razorpay = { verifyWebhookSignature: jest.fn().mockReturnValue(true) };
    stripe = { verifyWebhookSignature: jest.fn().mockReturnValue(true) };
    webhookDlq = {
      registerReplayer: jest.fn(),
      capture: jest.fn().mockResolvedValue({ id: 'dlq-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PaymentRepository, useValue: repository },
        { provide: RazorpayService, useValue: razorpay },
        { provide: StripeService, useValue: stripe },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_k: string, d?: unknown) => d) },
        },
        { provide: WebhookDlqService, useValue: webhookDlq },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  /**
   * Drive a webhook to the dead-letter path without touching the handlers:
   * the dispatch succeeds and the "mark processed" write is what fails, so
   * each test controls the resolver's lookups on their own. Combined with an
   * event type the module does not handle, every repository call these tests
   * see belongs to the resolver.
   */
  function failAfterDispatch() {
    repository.markWebhookProcessed!.mockRejectedValue(new Error('write conflict'));
  }

  /** The tenant the DLQ entry was filed under. */
  function capturedBusinessId(): string | null {
    const [entry] = webhookDlq.capture.mock.calls[0] as [{ businessId: string | null }];
    return entry.businessId;
  }

  // ── Razorpay tenant resolution ────────────────────────────────────────────

  describe('resolving the tenant for a failed Razorpay webhook', () => {
    /**
     * A Razorpay event the module does not dispatch, carrying only a refund
     * entity — so the resolver must walk past the payment and link slots.
     */
    const refundEvent = JSON.stringify({
      event: 'payment.dispute.created',
      payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } } },
    });

    it('falls through to the refund id when the event carries no payment', async () => {
      failAfterDispatch();
      repository.findRefundByGatewayId!.mockResolvedValue(makeRefundRow());

      await expect(service.handleRazorpayWebhook(refundEvent, 'sig')).rejects.toThrow(
        'write conflict',
      );

      expect(capturedBusinessId()).toBe(BUSINESS_ID);
      expect(repository.findRefundByGatewayId).toHaveBeenCalledWith('rfnd_1');
    });

    it('files the entry without a tenant when the refund is unknown', async () => {
      failAfterDispatch();
      // Every lookup misses — this is a webhook for a payment we never made.
      await expect(service.handleRazorpayWebhook(refundEvent, 'sig')).rejects.toThrow(
        'write conflict',
      );

      expect(capturedBusinessId()).toBeNull();
      expect(webhookDlq.capture).toHaveBeenCalledTimes(1);
    });

    it('stops at the payment entity without consulting the later ids', async () => {
      failAfterDispatch();
      repository.findPaymentByGatewayId!.mockResolvedValue({ business_id: BUSINESS_ID });

      await expect(
        service.handleRazorpayWebhook(
          JSON.stringify({
            event: 'payment.dispute.created',
            payload: {
              payment: { entity: { id: 'pay_1' } },
              // A stale link and refund on the same event must not be reached;
              // if they were, this DLQ entry would land in the wrong tenant.
              payment_link: { entity: { id: 'plink_x' } },
              refund: { entity: { id: 'rfnd_x' } },
            },
          }),
          'sig',
        ),
      ).rejects.toThrow('write conflict');

      expect(capturedBusinessId()).toBe(BUSINESS_ID);
      expect(repository.findPaymentByLinkId).not.toHaveBeenCalled();
      expect(repository.findRefundByGatewayId).not.toHaveBeenCalled();
    });

    it('falls through to the link id when the payment id misses', async () => {
      failAfterDispatch();
      repository.findPaymentByLinkId!.mockResolvedValue({ business_id: OTHER_BUSINESS });

      await expect(
        service.handleRazorpayWebhook(
          JSON.stringify({
            event: 'payment.dispute.created',
            payload: {
              payment: { entity: { id: 'pay_unknown' } },
              payment_link: { entity: { id: 'plink_1' } },
            },
          }),
          'sig',
        ),
      ).rejects.toThrow('write conflict');

      expect(capturedBusinessId()).toBe(OTHER_BUSINESS);
    });

    it('swallows a lookup failure rather than losing the dead-letter entry', async () => {
      failAfterDispatch();
      repository.findRefundByGatewayId!.mockRejectedValue(new Error('database is down'));

      // The caller must still see the *original* failure, and the webhook must
      // still be parked — a resolver that threw here would do neither.
      await expect(service.handleRazorpayWebhook(refundEvent, 'sig')).rejects.toThrow(
        'write conflict',
      );

      expect(webhookDlq.capture).toHaveBeenCalledTimes(1);
      expect(capturedBusinessId()).toBeNull();
    });
  });

  // ── Stripe tenant resolution ──────────────────────────────────────────────

  describe('resolving the tenant for a failed Stripe webhook', () => {
    function stripeEvent(object: Record<string, unknown>) {
      return JSON.stringify({
        id: 'evt_1',
        // An event type the module does not dispatch, so the only lookups
        // below are the resolver's.
        type: 'invoice.payment_succeeded',
        data: { object },
      });
    }

    it('resolves by checkout session id first', async () => {
      failAfterDispatch();
      repository.findPaymentByLinkId!.mockResolvedValue({ business_id: BUSINESS_ID });

      await expect(
        service.handleStripeWebhook(
          stripeEvent({ id: 'cs_1', payment_intent: 'pi_1' }),
          'sig',
        ),
      ).rejects.toThrow('write conflict');

      expect(capturedBusinessId()).toBe(BUSINESS_ID);
      expect(repository.findPaymentByGatewayId).not.toHaveBeenCalled();
    });

    it('falls through to the payment intent when the session is unknown', async () => {
      // A session we never recorded but an intent we did — this happens when
      // the checkout was created out-of-band and reconciliation filled in the
      // intent id.
      failAfterDispatch();
      repository.findPaymentByGatewayId!.mockResolvedValue({ business_id: OTHER_BUSINESS });

      await expect(
        service.handleStripeWebhook(
          stripeEvent({ id: 'cs_unknown', payment_intent: 'pi_1' }),
          'sig',
        ),
      ).rejects.toThrow('write conflict');

      expect(repository.findPaymentByGatewayId).toHaveBeenCalledWith('pi_1');
      expect(capturedBusinessId()).toBe(OTHER_BUSINESS);
    });

    it('files without a tenant when neither identifier is known', async () => {
      failAfterDispatch();

      await expect(
        service.handleStripeWebhook(stripeEvent({ id: 'cs_x', payment_intent: 'pi_x' }), 'sig'),
      ).rejects.toThrow('write conflict');

      expect(capturedBusinessId()).toBeNull();
    });

    it('copes with an event carrying no identifiers at all', async () => {
      failAfterDispatch();

      await expect(service.handleStripeWebhook(stripeEvent({}), 'sig')).rejects.toThrow(
        'write conflict',
      );

      expect(repository.findPaymentByLinkId).not.toHaveBeenCalled();
      expect(repository.findPaymentByGatewayId).not.toHaveBeenCalled();
      expect(capturedBusinessId()).toBeNull();
    });

    it('swallows a lookup failure rather than losing the dead-letter entry', async () => {
      failAfterDispatch();
      repository.findPaymentByLinkId!.mockRejectedValue(new Error('database is down'));

      await expect(
        service.handleStripeWebhook(stripeEvent({ id: 'cs_1' }), 'sig'),
      ).rejects.toThrow('write conflict');

      expect(webhookDlq.capture).toHaveBeenCalledTimes(1);
      expect(capturedBusinessId()).toBeNull();
    });
  });

  // ── Read-side plumbing ────────────────────────────────────────────────────

  describe('listPaymentLinks', () => {
    it('forwards every filter under the caller’s tenant', async () => {
      const page = { data: [], total: 0, page: 1, limit: 20, totalPages: 0 };
      repository.listPayments!.mockResolvedValue(page);

      const result = await service.listPaymentLinks(BUSINESS_ID, {
        status: 'PAID',
        orderId: ORDER_ID,
        clientId: 'client-1',
        page: 2,
        limit: 50,
      } as unknown as ListPaymentsQueryDto);

      expect(repository.listPayments).toHaveBeenCalledWith(BUSINESS_ID, {
        status: 'PAID',
        orderId: ORDER_ID,
        clientId: 'client-1',
        page: 2,
        limit: 50,
      });
      expect(result).toBe(page);
    });

    it('passes an empty query through without inventing defaults', async () => {
      repository.listPayments!.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      await service.listPaymentLinks(BUSINESS_ID, {} as ListPaymentsQueryDto);

      // The repository owns the defaults; duplicating them here would make the
      // two disagree the next time one is changed.
      expect(repository.listPayments).toHaveBeenCalledWith(BUSINESS_ID, {
        status: undefined,
        orderId: undefined,
        clientId: undefined,
        page: undefined,
        limit: undefined,
      });
    });
  });

  describe('listRefunds', () => {
    it('maps each row to a DTO and keeps the repository’s page metadata', async () => {
      repository.listRefunds!.mockResolvedValue({
        data: [makeRefundRow(), makeRefundRow({ id: 'refund-2' })],
        total: 57,
        page: 3,
        limit: 20,
        totalPages: 3,
      });

      const result = await service.listRefunds(BUSINESS_ID, { paymentId: PAYMENT_ID });

      expect(repository.listRefunds).toHaveBeenCalledWith(BUSINESS_ID, {
        paymentId: PAYMENT_ID,
      });
      expect(result).toMatchObject({ total: 57, page: 3, limit: 20, totalPages: 3 });
      expect(result.data).toHaveLength(2);
      // Column names never leak past the service boundary.
      expect(result.data[0]).not.toHaveProperty('business_id');
      expect(result.data[0]).toMatchObject({ id: REFUND_ID });
    });

    it('returns an empty page rather than null when there are no refunds', async () => {
      repository.listRefunds!.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      await expect(service.listRefunds(BUSINESS_ID, {})).resolves.toMatchObject({
        data: [],
        total: 0,
      });
    });
  });

  describe('getPaymentStats', () => {
    it('scopes the window to the caller’s tenant', async () => {
      const stats = { collectedPaise: 120000, pendingPaise: 0, failedPaise: 0 };
      repository.getPaymentStats!.mockResolvedValue(stats);

      await expect(
        service.getPaymentStats(BUSINESS_ID, { from: '2026-07-01', to: '2026-07-31' }),
      ).resolves.toBe(stats);

      expect(repository.getPaymentStats).toHaveBeenCalledWith(BUSINESS_ID, {
        from: '2026-07-01',
        to: '2026-07-31',
      });
    });
  });

  describe('getStatus', () => {
    it('reports the module as ready for the health probe', () => {
      expect(service.getStatus()).toEqual({ module: 'Payment', status: 'ready' });
    });
  });
});
