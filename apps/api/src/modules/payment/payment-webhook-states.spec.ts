/**
 * Gateway webhook state coverage — every terminal state, both gateways.
 *
 * The per-method suites next door test the paths that were already wired.
 * This one is organised by the *state a payment can reach*, because that is the
 * axis on which the gaps sat: a state the gateway reports and the platform does
 * not handle is money that moved with nothing in the ledger to match it, and
 * the absence looks identical to "no such event happened".
 *
 * Three of those were real:
 *
 *  - **A Stripe refund never completed.** `initiateRefund` called Stripe and
 *    moved the row to INITIATED; `charge.refunded` and `refund.updated` were a
 *    `logger.log` and nothing more. So the refund stayed INITIATED for the life
 *    of the record, the payment never reached REFUNDED/PARTIALLY_REFUNDED, and
 *    `payment.refund.completed` — which the order and the customer's
 *    confirmation hang off — never fired.
 *  - **`refund.failed` was unhandled on both.** A refund the gateway rejected
 *    stayed INITIATED, and INITIATED is inside the *committed* set that
 *    `sumCommittedRefundsForPayment` subtracts from the refundable balance. The
 *    money was never returned and could never be returned again.
 *  - **Disputes were unhandled entirely.** A chargeback against a captured
 *    payment produced no row, no log above debug, and no event.
 *
 * The suite drives the public entry points (`handleRazorpayWebhook` /
 * `handleStripeWebhook`) with real payload shapes rather than calling the
 * private handlers, so the dispatch table, the idempotency key and the tenant
 * resolution are all in the path being asserted.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { RazorpayService } from './razorpay.service';
import { StripeService } from './stripe.service';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import { PaymentStatus, RefundStatus } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-0000000000ff';
const CLIENT_ID = '00000000-0000-4000-a000-000000000002';
const PAYMENT_ID = '00000000-0000-4000-a000-000000000003';
const ORDER_ID = '00000000-0000-4000-a000-000000000004';
const REFUND_ID = '00000000-0000-4000-a000-000000000005';

/**
 * A Prisma `Decimal` stands in for a number here. `Number(payment.amount)` is
 * what the service calls, so the double has to survive that — a plain number
 * would too, but this keeps the shape honest about what the column returns.
 */
function decimal(value: number): { toNumber: () => number; toString: () => string } {
  return { toNumber: () => value, toString: () => value.toFixed(2) };
}

function mockPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    business_id: BUSINESS_ID,
    order_id: ORDER_ID,
    client_id: CLIENT_ID,
    status: PaymentStatus.SUCCESS,
    method: 'CARD',
    gateway: 'RAZORPAY',
    amount: decimal(500),
    currency: 'INR',
    gateway_order_id: null,
    gateway_payment_id: 'pay_gateway_1',
    gateway_signature: null,
    payment_link_url: null,
    payment_link_id: 'plink_1',
    payment_link_expires_at: null,
    initiated_at: null,
    captured_at: new Date(),
    failed_at: null,
    failure_reason: null,
    gateway_response: {},
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function mockRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    business_id: BUSINESS_ID,
    payment_id: PAYMENT_ID,
    order_id: ORDER_ID,
    status: RefundStatus.INITIATED,
    amount: decimal(500),
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
    initiated_at: new Date(),
    completed_at: null,
    failed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Payload builders — real gateway shapes
// ─────────────────────────────────────────────

function razorpayEvent(event: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_test',
    event,
    contains: Object.keys(payload),
    payload,
  });
}

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${type.replace(/\W/g, '_')}`,
): string {
  return JSON.stringify({ id, type, data: { object } });
}

describe('gateway webhook states', () => {
  let service: PaymentService;
  let repository: jest.Mocked<PaymentRepository>;
  let razorpay: jest.Mocked<RazorpayService>;
  let stripe: jest.Mocked<StripeService>;
  let emitter: jest.Mocked<EventEmitter2>;

  /** Every event this run emitted, as `[name, payload]`. */
  function emitted(name: string): Array<Record<string, unknown>> {
    return emitter.emit.mock.calls
      .filter(([eventName]) => eventName === name)
      .map(([, payload]) => payload as Record<string, unknown>);
  }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const mockRepository = {
      getPayment: jest.fn().mockResolvedValue(mockPayment()),
      updatePaymentStatus: jest.fn().mockResolvedValue(mockPayment()),
      claimPaymentSuccess: jest
        .fn()
        .mockResolvedValue({ payment: mockPayment(), claimed: true }),
      findPaymentByGatewayId: jest.fn().mockResolvedValue(mockPayment()),
      findPaymentByLinkId: jest.fn().mockResolvedValue(mockPayment()),
      findRefundByGatewayId: jest.fn().mockResolvedValue(mockRefund()),
      claimRefundSettlement: jest
        .fn()
        .mockResolvedValue({ refund: mockRefund(), claimed: true }),
      updateRefundStatus: jest.fn().mockResolvedValue(mockRefund()),
      recordPaymentDispute: jest.fn().mockResolvedValue(true),
      sumCompletedRefundsForPayment: jest.fn().mockResolvedValue(500),
      recordWebhookEvent: jest.fn().mockResolvedValue({ id: 'wh_1' }),
      markWebhookProcessed: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PaymentRepository, useValue: mockRepository },
        {
          provide: RazorpayService,
          useValue: { verifyWebhookSignature: jest.fn().mockReturnValue(true) },
        },
        {
          provide: StripeService,
          useValue: { verifyWebhookSignature: jest.fn().mockReturnValue(true) },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: WebhookDlqService,
          useValue: { capture: jest.fn(), registerReplayer: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(PaymentService);
    repository = module.get(PaymentRepository);
    razorpay = module.get(RazorpayService);
    stripe = module.get(StripeService);
    emitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────
  // Success
  // ─────────────────────────────────────────────

  describe('success', () => {
    it('settles a Razorpay capture and emits payment.success once', async () => {
      await service.handleRazorpayWebhook(
        razorpayEvent('payment.captured', {
          payment: {
            entity: { id: 'pay_gateway_1', amount: 50000, currency: 'INR', status: 'captured', method: 'upi' },
          },
        }),
        'sig',
      );

      expect(repository.claimPaymentSuccess).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ gatewayPaymentId: 'pay_gateway_1' }),
      );
      expect(emitted('payment.success')).toHaveLength(1);
    });

    it('settles a Stripe checkout and emits payment.success once', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        mockPayment({ status: PaymentStatus.PENDING, gateway: 'STRIPE' }) as never,
      );

      await service.handleStripeWebhook(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1',
          object: 'checkout_session',
          payment_intent: 'pi_1',
          payment_method_types: ['card'],
          amount_total: 50000,
          currency: 'usd',
        }),
        't=1,v1=sig',
      );

      expect(repository.claimPaymentSuccess).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ gatewayPaymentId: 'pi_1' }),
      );
      expect(emitted('payment.success')).toHaveLength(1);
    });

    it('does not emit payment.success a second time when the claim is lost', async () => {
      // The reconcile sweep got there first. `claimed: false` is the only
      // signal that says so — the row now reads SUCCESS either way.
      repository.claimPaymentSuccess.mockResolvedValue({
        payment: mockPayment(),
        claimed: false,
      } as never);

      await service.handleRazorpayWebhook(
        razorpayEvent('payment.captured', {
          payment: { entity: { id: 'pay_gateway_1', amount: 50000, currency: 'INR', status: 'captured' } },
        }),
        'sig',
      );

      expect(emitted('payment.success')).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────
  // Failure and expiry
  // ─────────────────────────────────────────────

  describe('failure', () => {
    it('marks a Razorpay payment FAILED and carries the gateway reason through', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(
        mockPayment({ status: PaymentStatus.PENDING }) as never,
      );

      await service.handleRazorpayWebhook(
        razorpayEvent('payment.failed', {
          payment: {
            entity: {
              id: 'pay_gateway_1',
              amount: 50000,
              currency: 'INR',
              status: 'failed',
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Payment was declined by the issuing bank',
            },
          },
        }),
        'sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.FAILED,
          failureReason: 'Payment was declined by the issuing bank',
        }),
      );
      expect(emitted('payment.failed')).toHaveLength(1);
    });

    it('marks a Stripe payment FAILED from the PaymentIntent error', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(
        mockPayment({ status: PaymentStatus.PENDING, gateway: 'STRIPE' }) as never,
      );

      await service.handleStripeWebhook(
        stripeEvent('payment_intent.payment_failed', {
          id: 'pi_1',
          object: 'payment_intent',
          last_payment_error: { message: 'Your card was declined.', code: 'card_declined' },
        }),
        't=1,v1=sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.FAILED,
          failureReason: 'Your card was declined.',
        }),
      );
    });

    it('expires an abandoned Stripe checkout without emitting a failure', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        mockPayment({ status: PaymentStatus.PENDING, gateway: 'STRIPE' }) as never,
      );

      await service.handleStripeWebhook(
        stripeEvent('checkout.session.expired', { id: 'cs_1', object: 'checkout_session' }),
        't=1,v1=sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.EXPIRED }),
      );
      // An expiry is not a decline. Nothing downstream should tell the customer
      // their card was refused.
      expect(emitted('payment.failed')).toHaveLength(0);
    });

    it('never walks a settled payment back to EXPIRED', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        mockPayment({ status: PaymentStatus.SUCCESS }) as never,
      );

      await service.handleStripeWebhook(
        stripeEvent('checkout.session.expired', { id: 'cs_1', object: 'checkout_session' }),
        't=1,v1=sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Refunds — the state both gateways have to reach
  // ─────────────────────────────────────────────

  describe('refund settlement', () => {
    const RAZORPAY_PROCESSED = razorpayEvent('refund.processed', {
      refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'processed' } },
    });

    /**
     * Both gateways, one table. The parameterisation is the point: the ledger
     * consequences of a returned rupee cannot depend on who returned it, and
     * before this the Razorpay column was the only one that had any.
     */
    const SETTLEMENTS: Array<[string, () => Promise<void>]> = [
      ['Razorpay refund.processed', () => service.handleRazorpayWebhook(RAZORPAY_PROCESSED, 'sig')],
      [
        'Stripe refund.updated',
        () =>
          service.handleStripeWebhook(
            stripeEvent('refund.updated', {
              id: 'rfnd_1',
              object: 'refund',
              status: 'succeeded',
              amount: 50000,
              charge: 'ch_1',
            }),
            't=1,v1=sig',
          ),
      ],
      [
        'Stripe charge.refunded',
        () =>
          service.handleStripeWebhook(
            stripeEvent('charge.refunded', {
              id: 'ch_1',
              object: 'charge',
              amount: 50000,
              refunds: { data: [{ id: 'rfnd_1', status: 'succeeded', amount: 50000 }] },
            }),
            't=1,v1=sig',
          ),
      ],
    ];

    it.each(SETTLEMENTS)('%s moves the refund to COMPLETED', async (_label, run) => {
      await run();

      expect(repository.claimRefundSettlement).toHaveBeenCalledWith(
        BUSINESS_ID,
        REFUND_ID,
        expect.objectContaining({
          status: RefundStatus.COMPLETED,
          completedAt: expect.any(Date),
        }),
      );
    });

    it.each(SETTLEMENTS)('%s emits payment.refund.completed exactly once', async (_label, run) => {
      await run();

      const events = emitted('payment.refund.completed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'payment.refund.completed',
        businessId: BUSINESS_ID,
        refundId: REFUND_ID,
        paymentId: PAYMENT_ID,
        clientId: CLIENT_ID,
      });
    });

    it.each(SETTLEMENTS)('%s rolls a fully refunded payment to REFUNDED', async (_label, run) => {
      repository.sumCompletedRefundsForPayment.mockResolvedValue(500);

      await run();

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.REFUNDED }),
      );
    });

    it.each(SETTLEMENTS)('%s rolls a part-refunded payment to PARTIALLY_REFUNDED', async (_label, run) => {
      repository.sumCompletedRefundsForPayment.mockResolvedValue(250);

      await run();

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.PARTIALLY_REFUNDED }),
      );
    });

    it.each(SETTLEMENTS)('%s emits nothing when it loses the settlement claim', async (_label, run) => {
      repository.claimRefundSettlement.mockResolvedValue({
        refund: mockRefund({ status: RefundStatus.COMPLETED }),
        claimed: false,
      } as never);

      await run();

      expect(emitted('payment.refund.completed')).toHaveLength(0);
      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('settles every refund a multi-refund charge carries, not just the first', async () => {
      // A charge refunded twice arrives as one `charge.refunded` listing both.
      // Taking `refunds.data[0]` leaves the second refund INITIATED forever.
      repository.findRefundByGatewayId.mockImplementation(async (id: string) =>
        mockRefund({ id: `refund-row-${id}`, gateway_refund_id: id }) as never,
      );

      await service.handleStripeWebhook(
        stripeEvent('charge.refunded', {
          id: 'ch_1',
          object: 'charge',
          amount: 50000,
          refunds: {
            data: [
              { id: 'rfnd_a', status: 'succeeded', amount: 20000 },
              { id: 'rfnd_b', status: 'succeeded', amount: 30000 },
            ],
          },
        }),
        't=1,v1=sig',
      );

      expect(repository.findRefundByGatewayId).toHaveBeenCalledWith('rfnd_a');
      expect(repository.findRefundByGatewayId).toHaveBeenCalledWith('rfnd_b');
      expect(repository.claimRefundSettlement).toHaveBeenCalledTimes(2);
    });

    it('leaves a still-pending Stripe refund alone', async () => {
      await service.handleStripeWebhook(
        stripeEvent('refund.updated', {
          id: 'rfnd_1',
          object: 'refund',
          status: 'pending',
          amount: 50000,
        }),
        't=1,v1=sig',
      );

      // Claiming here would mark money as returned before Stripe moved it.
      expect(repository.claimRefundSettlement).not.toHaveBeenCalled();
      expect(emitted('payment.refund.completed')).toHaveLength(0);
    });

    it('tolerates a refund event for a refund this platform has no row for', async () => {
      repository.findRefundByGatewayId.mockResolvedValue(null as never);

      await expect(
        service.handleRazorpayWebhook(RAZORPAY_PROCESSED, 'sig'),
      ).resolves.toBeUndefined();

      expect(repository.claimRefundSettlement).not.toHaveBeenCalled();
    });
  });

  describe('refund failure', () => {
    it('releases the reservation when Razorpay rejects the refund', async () => {
      await service.handleRazorpayWebhook(
        razorpayEvent('refund.failed', {
          refund: {
            entity: {
              id: 'rfnd_1',
              payment_id: 'pay_gateway_1',
              amount: 50000,
              status: 'failed',
              error_description: 'Refund failed at the bank',
            },
          },
        }),
        'sig',
      );

      // FAILED is outside `sumCommittedRefundsForPayment`'s set, so this is
      // what hands the balance back and lets the refund be retried at all.
      expect(repository.claimRefundSettlement).toHaveBeenCalledWith(
        BUSINESS_ID,
        REFUND_ID,
        expect.objectContaining({
          status: RefundStatus.FAILED,
          failedAt: expect.any(Date),
        }),
      );
    });

    it.each(['failed', 'canceled'])(
      'releases the reservation when Stripe reports the refund as %s',
      async (status) => {
        await service.handleStripeWebhook(
          stripeEvent('refund.updated', {
            id: 'rfnd_1',
            object: 'refund',
            status,
            amount: 50000,
            failure_reason: 'expired_or_canceled_card',
          }),
          't=1,v1=sig',
        );

        expect(repository.claimRefundSettlement).toHaveBeenCalledWith(
          BUSINESS_ID,
          REFUND_ID,
          expect.objectContaining({ status: RefundStatus.FAILED }),
        );
      },
    );

    it('does not announce a refund that did not happen', async () => {
      await service.handleRazorpayWebhook(
        razorpayEvent('refund.failed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'failed' } },
        }),
        'sig',
      );

      // `payment.refund.completed` drives the customer's confirmation. Firing
      // it here would tell them money was returned that the bank refused.
      expect(emitted('payment.refund.completed')).toHaveLength(0);
      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('cannot walk a COMPLETED refund back to FAILED', async () => {
      // The repository's predicate is what enforces this; the service must
      // read `claimed` rather than assume the write landed.
      repository.claimRefundSettlement.mockResolvedValue({
        refund: mockRefund({ status: RefundStatus.COMPLETED }),
        claimed: false,
      } as never);

      await service.handleRazorpayWebhook(
        razorpayEvent('refund.failed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'failed' } },
        }),
        'sig',
      );

      expect(emitted('payment.refund.completed')).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────
  // Disputes
  // ─────────────────────────────────────────────

  describe('disputes', () => {
    function razorpayDispute(event: string, status: string): string {
      return razorpayEvent(event, {
        dispute: {
          entity: {
            id: 'disp_1',
            payment_id: 'pay_gateway_1',
            amount: 50000,
            currency: 'INR',
            status,
            reason_code: 'fraud',
            reason_description: 'Cardholder does not recognise the transaction',
          },
        },
      });
    }

    it('records an opened Razorpay dispute against the payment', async () => {
      await service.handleRazorpayWebhook(razorpayDispute('payment.dispute.created', 'open'), 'sig');

      expect(repository.recordPaymentDispute).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        'disp_1',
        expect.objectContaining({
          status: 'open',
          amountPaise: 50000,
          currency: 'INR',
          reason: 'Cardholder does not recognise the transaction',
          resolution: null,
        }),
      );
    });

    it('announces an opened dispute as payment.disputed', async () => {
      await service.handleRazorpayWebhook(razorpayDispute('payment.dispute.created', 'open'), 'sig');

      const events = emitted('payment.disputed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'payment.disputed',
        businessId: BUSINESS_ID,
        paymentId: PAYMENT_ID,
        clientId: CLIENT_ID,
        gatewayDisputeId: 'disp_1',
        gatewayStatus: 'open',
        amountPaise: 50000,
      });
      expect(events[0]).not.toHaveProperty('resolution');
    });

    it.each([
      ['payment.dispute.won', 'won', 'WON'],
      ['payment.dispute.lost', 'lost', 'LOST'],
      ['payment.dispute.closed', 'closed', 'CLOSED'],
    ])('resolves %s as %s', async (event, status, resolution) => {
      await service.handleRazorpayWebhook(razorpayDispute(event, status), 'sig');

      const events = emitted('payment.dispute.resolved');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'payment.dispute.resolved', resolution });
    });

    it('records a Stripe dispute found via its charge', async () => {
      await service.handleStripeWebhook(
        stripeEvent('charge.dispute.created', {
          id: 'dp_1',
          object: 'dispute',
          charge: 'ch_1',
          amount: 4999,
          currency: 'usd',
          status: 'warning_needs_response',
          reason: 'fraudulent',
        }),
        't=1,v1=sig',
      );

      expect(repository.findPaymentByGatewayId).toHaveBeenCalledWith('ch_1');
      expect(repository.recordPaymentDispute).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        'dp_1',
        expect.objectContaining({ status: 'warning_needs_response', amountPaise: 4999, currency: 'USD' }),
      );
    });

    it('falls back to the PaymentIntent when a Stripe dispute names no charge', async () => {
      await service.handleStripeWebhook(
        stripeEvent('charge.dispute.created', {
          id: 'dp_1',
          object: 'dispute',
          payment_intent: 'pi_1',
          amount: 4999,
          currency: 'usd',
          status: 'needs_response',
        }),
        't=1,v1=sig',
      );

      expect(repository.findPaymentByGatewayId).toHaveBeenCalledWith('pi_1');
    });

    it('reads the outcome from a Stripe dispute status, not its event name', async () => {
      // Stripe sends one generic `charge.dispute.closed` and puts the verdict
      // in `status`; Razorpay puts it in the event name. Both have to resolve.
      await service.handleStripeWebhook(
        stripeEvent('charge.dispute.closed', {
          id: 'dp_1',
          object: 'dispute',
          charge: 'ch_1',
          amount: 4999,
          currency: 'usd',
          status: 'lost',
        }),
        't=1,v1=sig',
      );

      expect(emitted('payment.dispute.resolved')[0]).toMatchObject({ resolution: 'LOST' });
    });

    it('leaves the payment status alone — a dispute is not a refund', async () => {
      await service.handleRazorpayWebhook(razorpayDispute('payment.dispute.lost', 'lost'), 'sig');

      // PaymentStatus has no term for "contested", and overwriting SUCCESS
      // here would corrupt every revenue figure that reads it.
      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('tolerates a dispute against a payment this platform has no row for', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(null as never);

      await expect(
        service.handleRazorpayWebhook(razorpayDispute('payment.dispute.created', 'open'), 'sig'),
      ).resolves.toBeUndefined();

      expect(repository.recordPaymentDispute).not.toHaveBeenCalled();
    });

    it('tolerates a dispute event with no dispute entity at all', async () => {
      await expect(
        service.handleRazorpayWebhook(razorpayEvent('payment.dispute.created', {}), 'sig'),
      ).resolves.toBeUndefined();

      expect(repository.recordPaymentDispute).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Idempotency keys
  // ─────────────────────────────────────────────

  describe('idempotency keys', () => {
    /** The `external_id` the run wrote to `webhook_events`. */
    function recordedKey(): string {
      const call = repository.recordWebhookEvent.mock.calls[0]?.[0] as { externalId: string };
      return call.externalId;
    }

    it('keys a dispute on the dispute, not on the payment it is against', async () => {
      // `payment.dispute.created` starts with the `payment` namespace, so the
      // namespace rule alone would key it on the payment — and two disputes
      // against one payment would then collide, the second discarded
      // unprocessed for the life of the row.
      await service.handleRazorpayWebhook(
        razorpayEvent('payment.dispute.created', {
          dispute: { entity: { id: 'disp_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'open' } },
          payment: { entity: { id: 'pay_gateway_1', amount: 50000, currency: 'INR', status: 'captured' } },
        }),
        'sig',
      );

      expect(recordedKey()).toBe('payment.dispute.created_disp_1');
    });

    it('keys each stage of one dispute distinctly', async () => {
      const keys: string[] = [];
      for (const event of ['payment.dispute.created', 'payment.dispute.lost']) {
        repository.recordWebhookEvent.mockClear();
        await service.handleRazorpayWebhook(
          razorpayEvent(event, {
            dispute: { entity: { id: 'disp_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'open' } },
          }),
          'sig',
        );
        keys.push(recordedKey());
      }

      expect(new Set(keys).size).toBe(2);
    });

    it('still keys a refund on the refund when a payment rides along', async () => {
      await service.handleRazorpayWebhook(
        razorpayEvent('refund.processed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'processed' } },
          payment: { entity: { id: 'pay_gateway_1', amount: 50000, currency: 'INR', status: 'captured' } },
        }),
        'sig',
      );

      expect(recordedKey()).toBe('refund.processed_rfnd_1');
    });

    it('processes nothing on a duplicate delivery', async () => {
      repository.recordWebhookEvent.mockResolvedValue(null as never);

      await service.handleRazorpayWebhook(
        razorpayEvent('refund.processed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'processed' } },
        }),
        'sig',
      );

      expect(repository.claimRefundSettlement).not.toHaveBeenCalled();
      expect(emitted('payment.refund.completed')).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────
  // Signature and tenant
  // ─────────────────────────────────────────────

  describe('signature and tenant scoping', () => {
    it.each([
      [
        'Razorpay',
        () => razorpay.verifyWebhookSignature.mockReturnValue(false),
        () =>
          service.handleRazorpayWebhook(
            razorpayEvent('payment.dispute.created', {
              dispute: { entity: { id: 'disp_1', payment_id: 'p', amount: 1, status: 'open' } },
            }),
            'bad',
          ),
      ],
      [
        'Stripe',
        () => stripe.verifyWebhookSignature.mockReturnValue(false),
        () =>
          service.handleStripeWebhook(
            stripeEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_1' }),
            'bad',
          ),
      ],
    ])('%s refuses an unsigned dispute before it reaches the ledger', async (_g, arrange, run) => {
      arrange();

      await expect(run()).rejects.toThrow('Invalid webhook signature');

      expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
      expect(repository.recordPaymentDispute).not.toHaveBeenCalled();
    });

    it('writes every settlement under the tenant on the row, never a caller-supplied one', async () => {
      // The webhook is unauthenticated: nothing in the payload names a tenant,
      // and the only businessId that may be used is the one already on the
      // refund/payment row the gateway id resolved to.
      repository.findRefundByGatewayId.mockResolvedValue(
        mockRefund({ business_id: OTHER_BUSINESS_ID }) as never,
      );
      repository.claimRefundSettlement.mockResolvedValue({
        refund: mockRefund({ business_id: OTHER_BUSINESS_ID }),
        claimed: true,
      } as never);
      repository.getPayment.mockResolvedValue(
        mockPayment({ business_id: OTHER_BUSINESS_ID }) as never,
      );

      await service.handleRazorpayWebhook(
        razorpayEvent('refund.processed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'processed' } },
        }),
        'sig',
      );

      for (const call of repository.claimRefundSettlement.mock.calls) {
        expect(call[0]).toBe(OTHER_BUSINESS_ID);
      }
      for (const call of repository.getPayment.mock.calls) {
        expect(call[0]).toBe(OTHER_BUSINESS_ID);
      }
      for (const call of repository.updatePaymentStatus.mock.calls) {
        expect(call[0]).toBe(OTHER_BUSINESS_ID);
      }
      expect(emitted('payment.refund.completed')[0]).toMatchObject({
        businessId: OTHER_BUSINESS_ID,
      });
    });

    it('records a dispute under the disputed payment tenant', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(
        mockPayment({ business_id: OTHER_BUSINESS_ID }) as never,
      );

      await service.handleRazorpayWebhook(
        razorpayEvent('payment.dispute.created', {
          dispute: { entity: { id: 'disp_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'open' } },
        }),
        'sig',
      );

      expect(repository.recordPaymentDispute).toHaveBeenCalledWith(
        OTHER_BUSINESS_ID,
        PAYMENT_ID,
        'disp_1',
        expect.anything(),
      );
      expect(emitted('payment.disputed')[0]).toMatchObject({ businessId: OTHER_BUSINESS_ID });
    });
  });

  // ─────────────────────────────────────────────
  // Monetary precision
  // ─────────────────────────────────────────────

  describe('monetary precision', () => {
    /**
     * The rupee/paise boundary is where float error becomes a wrong number on
     * an invoice. `Decimal(14,2)` rupees come off the row and are compared in
     * paise, and `x * 100` is not exact for every two-decimal value —
     * `19.99 * 100` is `1998.9999999999998`, which truncates to 1998 and makes
     * a fully-refunded payment read as partially refunded forever.
     */
    it.each([
      [19.99, 1999],
      [0.01, 1],
      [1234.56, 123456],
      [99999.99, 9999999],
      [8.7, 870],
      [1.005, 101],
    ])('a %s-rupee payment fully refunded reaches REFUNDED, not PARTIALLY_REFUNDED', async (
      rupees,
      _paise,
    ) => {
      repository.getPayment.mockResolvedValue(mockPayment({ amount: decimal(rupees) }) as never);
      repository.sumCompletedRefundsForPayment.mockResolvedValue(rupees);

      await service.handleRazorpayWebhook(
        razorpayEvent('refund.processed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 1, status: 'processed' } },
        }),
        'sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.REFUNDED }),
      );
    });

    it('a refund one paise short stays PARTIALLY_REFUNDED', async () => {
      repository.getPayment.mockResolvedValue(mockPayment({ amount: decimal(19.99) }) as never);
      repository.sumCompletedRefundsForPayment.mockResolvedValue(19.98);

      await service.handleRazorpayWebhook(
        razorpayEvent('refund.processed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 1998, status: 'processed' } },
        }),
        'sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.PARTIALLY_REFUNDED }),
      );
    });

    it('carries the refund amount into the event in paise, as an integer', async () => {
      repository.claimRefundSettlement.mockResolvedValue({
        refund: mockRefund({ amount: decimal(19.99) }),
        claimed: true,
      } as never);

      await service.handleRazorpayWebhook(
        razorpayEvent('refund.processed', {
          refund: { entity: { id: 'rfnd_1', payment_id: 'pay_gateway_1', amount: 1999, status: 'processed' } },
        }),
        'sig',
      );

      const amount = emitted('payment.refund.completed')[0]?.['amountPaise'];
      expect(amount).toBe(1999);
      expect(Number.isInteger(amount)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // Dead-lettering
  // ─────────────────────────────────────────────

  describe('dead-lettering', () => {
    it('parks a failed dispute event under the disputed payment tenant', async () => {
      const dlq = { capture: jest.fn(), registerReplayer: jest.fn() };
      const module = await Test.createTestingModule({
        providers: [
          PaymentService,
          {
            provide: PaymentRepository,
            useValue: {
              ...repository,
              recordWebhookEvent: jest.fn().mockResolvedValue({ id: 'wh_1' }),
              findPaymentByGatewayId: jest
                .fn()
                .mockResolvedValue(mockPayment({ business_id: OTHER_BUSINESS_ID })),
              recordPaymentDispute: jest.fn().mockRejectedValue(new Error('db down')),
            },
          },
          { provide: RazorpayService, useValue: { verifyWebhookSignature: () => true } },
          { provide: StripeService, useValue: { verifyWebhookSignature: () => true } },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
          { provide: ConfigService, useValue: { get: jest.fn() } },
          { provide: WebhookDlqService, useValue: dlq },
        ],
      }).compile();

      const svc = module.get(PaymentService);

      await expect(
        svc.handleRazorpayWebhook(
          razorpayEvent('payment.dispute.created', {
            dispute: { entity: { id: 'disp_1', payment_id: 'pay_gateway_1', amount: 50000, status: 'open' } },
          }),
          'sig',
        ),
      ).rejects.toThrow('db down');

      // Without the dispute's own tenant lookup this lands in the platform
      // bucket — the one queue no tenant's operator is looking at.
      expect(dlq.capture).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: OTHER_BUSINESS_ID, source: 'RAZORPAY' }),
        expect.any(Error),
      );
    });
  });
});
