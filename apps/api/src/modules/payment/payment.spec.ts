import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { RazorpayService } from './razorpay.service';
import { StripeService } from './stripe.service';
import {
  CreatePaymentLinkDto,
  InitiateRefundDto,
  ConfirmCODDto,
} from './dto';
import { PaymentStatus, PaymentGateway } from '@gosumo/shared';
import type { OrderCreatedEvent } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CLIENT_ID = '00000000-0000-4000-a000-000000000002';
const PAYMENT_ID = '00000000-0000-4000-a000-000000000003';
const ORDER_ID = '00000000-0000-4000-a000-000000000004';
const REFUND_ID = '00000000-0000-4000-a000-000000000005';

function createMockPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    business_id: BUSINESS_ID,
    order_id: ORDER_ID,
    client_id: CLIENT_ID,
    status: 'PENDING',
    method: null,
    gateway: 'RAZORPAY',
    amount: { toNumber: () => 500, toString: () => '500.00' },
    currency: 'INR',
    gateway_order_id: null,
    gateway_payment_id: null,
    gateway_signature: null,
    payment_link_url: 'https://rzp.io/test',
    payment_link_id: 'plink_test123',
    payment_link_expires_at: new Date(Date.now() + 86400000),
    initiated_at: null,
    captured_at: null,
    failed_at: null,
    failure_reason: null,
    gateway_response: {},
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function createMockRefund(overrides: Record<string, unknown> = {}) {
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
    gateway_refund_id: null,
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
// Test suite
// ─────────────────────────────────────────────

describe('PaymentService', () => {
  let service: PaymentService;
  let repository: jest.Mocked<PaymentRepository>;
  let razorpay: jest.Mocked<RazorpayService>;
  let stripe: jest.Mocked<StripeService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository = {
      createPayment: jest.fn(),
      getPayment: jest.fn(),
      listPayments: jest.fn(),
      updatePaymentStatus: jest.fn(),
      findPaymentByGatewayId: jest.fn(),
      findPaymentByGatewayOrderId: jest.fn(),
      findPaymentByLinkId: jest.fn(),
      createRefund: jest.fn(),
      getRefund: jest.fn(),
      listRefunds: jest.fn(),
      updateRefundStatus: jest.fn(),
      findRefundByGatewayId: jest.fn(),
      sumCompletedRefundsForPayment: jest.fn(),
      getPaymentSummaryForOrder: jest.fn(),
      recordWebhookEvent: jest.fn(),
      markWebhookProcessed: jest.fn(),
      listReconcilablePayments: jest.fn(),
    };

    const mockRazorpay = {
      createPaymentLink: jest.fn(),
      createRefund: jest.fn(),
      fetchPaymentLinkStatus: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    };

    const mockStripe = {
      createCheckoutSession: jest.fn(),
      createRefund: jest.fn(),
      fetchSessionStatus: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    };

    const mockEventEmitter = {
      emit: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'BUSINESS_MAX_REFUND_PAISE') return 1_000_000;
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PaymentRepository, useValue: mockRepository },
        { provide: RazorpayService, useValue: mockRazorpay },
        { provide: StripeService, useValue: mockStripe },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    repository = module.get(PaymentRepository);
    razorpay = module.get(RazorpayService);
    stripe = module.get(StripeService);
    eventEmitter = module.get(EventEmitter2);
  });

  // ─────────────────────────────────────────────
  // createPaymentLink
  // ─────────────────────────────────────────────

  describe('createPaymentLink', () => {
    it('should create a payment link and emit payment.created event', async () => {
      const dto: CreatePaymentLinkDto = {
        clientId: CLIENT_ID,
        amountPaise: 50000,
        description: 'Test payment',
        orderId: ORDER_ID,
      };

      razorpay.createPaymentLink.mockResolvedValue({
        id: 'plink_test123',
        shortUrl: 'https://rzp.io/test',
        url: 'https://rzp.io/test/full',
        status: 'created',
        amountPaise: 50000,
      });

      const mockPayment = createMockPayment({ amount: { toNumber: () => 500, toString: () => '500.00' } });
      repository.createPayment.mockResolvedValue(mockPayment as never);

      const result = await service.createPaymentLink(BUSINESS_ID, dto);

      expect(result.id).toBe(PAYMENT_ID);
      expect(result.amountPaise).toBe(50000);
      expect(result.paymentLinkUrl).toBe('https://rzp.io/test');
      expect(result.status).toBe('PENDING');

      // Verify Razorpay was called
      expect(razorpay.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({
          amountPaise: 50000,
          currency: 'INR',
          description: 'Test payment',
        }),
      );

      // Verify payment record was created
      expect(repository.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          clientId: CLIENT_ID,
          amountRupees: 500,
          gateway: PaymentGateway.RAZORPAY,
        }),
      );

      // Verify event was emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.created',
        expect.objectContaining({
          type: 'payment.created',
          businessId: BUSINESS_ID,
          paymentId: PAYMENT_ID,
          amountPaise: 50000,
        }),
      );
    });

    it('should use default expiry of 1440 minutes when not specified', async () => {
      const dto: CreatePaymentLinkDto = {
        clientId: CLIENT_ID,
        amountPaise: 10000,
      };

      razorpay.createPaymentLink.mockResolvedValue({
        id: 'plink_test',
        shortUrl: 'https://rzp.io/t',
        url: 'https://rzp.io/t',
        status: 'created',
        amountPaise: 10000,
      });

      repository.createPayment.mockResolvedValue(createMockPayment() as never);

      await service.createPaymentLink(BUSINESS_ID, dto);

      // Verify that expireBy was set (should be ~24h from now)
      expect(razorpay.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({
          expireBy: expect.any(Number),
        }),
      );

      const call = razorpay.createPaymentLink.mock.calls[0]![0];
      const expireBy = call.expireBy!;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expectedExpiry = nowSeconds + 1440 * 60; // 24h from now in seconds

      // Allow 5 second tolerance for test execution time
      expect(Math.abs(expireBy - expectedExpiry)).toBeLessThan(5);
    });
  });

  // ─────────────────────────────────────────────
  // handleRazorpayWebhook — valid signature
  // ─────────────────────────────────────────────

  describe('handleRazorpayWebhook', () => {
    const validPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment_link.paid',
      contains: ['payment_link', 'payment'],
      payload: {
        payment_link: {
          entity: {
            id: 'plink_test123',
            status: 'paid',
            amount: 50000,
            amount_paid: 50000,
          },
        },
        payment: {
          entity: {
            id: 'pay_test456',
            amount: 50000,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
    });

    it('should process payment_link.paid with valid signature', async () => {
      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_1' });
      repository.findPaymentByLinkId.mockResolvedValue(
        createMockPayment() as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      await service.handleRazorpayWebhook(validPayload, 'valid_sig');

      expect(razorpay.verifyWebhookSignature).toHaveBeenCalledWith(
        validPayload,
        'valid_sig',
      );

      // Verify webhook event was recorded
      expect(repository.recordWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'RAZORPAY',
          eventType: 'payment_link.paid',
          signatureValid: true,
        }),
      );

      // Verify payment was updated to SUCCESS
      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.SUCCESS,
          gatewayPaymentId: 'pay_test456',
        }),
      );

      // Verify payment.success event was emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.success',
        expect.objectContaining({
          type: 'payment.success',
          paymentId: PAYMENT_ID,
          businessId: BUSINESS_ID,
        }),
      );

      // Verify webhook was marked as processed
      expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_1');
    });

    it('should reject webhook with invalid signature', async () => {
      razorpay.verifyWebhookSignature.mockReturnValue(false);

      await expect(
        service.handleRazorpayWebhook(validPayload, 'bad_sig'),
      ).rejects.toThrow(UnauthorizedException);

      // Should NOT record webhook event or process anything
      expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
    });

    it('should process payment.failed webhook', async () => {
      const failedPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment.failed',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_fail789',
              amount: 50000,
              currency: 'INR',
              status: 'failed',
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Insufficient funds',
            },
          },
        },
      });

      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_2' });
      repository.findPaymentByGatewayId.mockResolvedValue(
        createMockPayment() as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({ status: 'FAILED' }) as never,
      );

      await service.handleRazorpayWebhook(failedPayload, 'valid_sig');

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.FAILED,
          failureReason: 'Insufficient funds',
        }),
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({
          type: 'payment.failed',
          reason: 'Insufficient funds',
        }),
      );
    });

    it('should complete the refund and mark payment REFUNDED on refund.processed (full refund)', async () => {
      const refundPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'refund.processed',
        contains: ['refund'],
        payload: {
          refund: {
            entity: {
              id: 'rfnd_test123',
              payment_id: 'pay_test456',
              amount: 50000,
              status: 'processed',
            },
          },
        },
      });

      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_3' });
      repository.findRefundByGatewayId.mockResolvedValue(
        createMockRefund({ gateway_refund_id: 'rfnd_test123' }) as never,
      );
      repository.getPayment.mockResolvedValue(createMockPayment() as never);
      repository.sumCompletedRefundsForPayment.mockResolvedValue(500);

      await service.handleRazorpayWebhook(refundPayload, 'valid_sig');

      expect(repository.updateRefundStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        REFUND_ID,
        expect.objectContaining({ status: 'COMPLETED' }),
      );
      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.REFUNDED }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.refund.completed',
        expect.objectContaining({
          type: 'payment.refund.completed',
          refundId: REFUND_ID,
          paymentId: PAYMENT_ID,
        }),
      );
    });

    it('should mark payment PARTIALLY_REFUNDED when refunded total is less than payment amount', async () => {
      const refundPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'refund.processed',
        contains: ['refund'],
        payload: {
          refund: {
            entity: {
              id: 'rfnd_partial',
              payment_id: 'pay_test456',
              amount: 25000,
              status: 'processed',
            },
          },
        },
      });

      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_4' });
      repository.findRefundByGatewayId.mockResolvedValue(
        createMockRefund({ gateway_refund_id: 'rfnd_partial' }) as never,
      );
      repository.getPayment.mockResolvedValue(createMockPayment() as never);
      repository.sumCompletedRefundsForPayment.mockResolvedValue(250);

      await service.handleRazorpayWebhook(refundPayload, 'valid_sig');

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.PARTIALLY_REFUNDED }),
      );
    });

    it('should skip already-COMPLETED refunds on redelivered refund.processed webhooks', async () => {
      const refundPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'refund.processed',
        contains: ['refund'],
        payload: {
          refund: {
            entity: {
              id: 'rfnd_done',
              payment_id: 'pay_test456',
              amount: 50000,
              status: 'processed',
            },
          },
        },
      });

      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_5' });
      repository.findRefundByGatewayId.mockResolvedValue(
        createMockRefund({ gateway_refund_id: 'rfnd_done', status: 'COMPLETED' }) as never,
      );

      await service.handleRazorpayWebhook(refundPayload, 'valid_sig');

      expect(repository.updateRefundStatus).not.toHaveBeenCalled();
      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('should log and skip refund.processed when no matching refund record exists', async () => {
      const refundPayload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'refund.processed',
        contains: ['refund'],
        payload: {
          refund: {
            entity: {
              id: 'rfnd_unknown',
              payment_id: 'pay_unknown',
              amount: 50000,
              status: 'processed',
            },
          },
        },
      });

      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_6' });
      repository.findRefundByGatewayId.mockResolvedValue(null);

      await service.handleRazorpayWebhook(refundPayload, 'valid_sig');

      expect(repository.updateRefundStatus).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'payment.refund.completed',
        expect.anything(),
      );
    });
  });

  // ─────────────────────────────────────────────
  // Webhook idempotency
  // ─────────────────────────────────────────────

  describe('webhook idempotency', () => {
    it('should skip duplicate webhook events', async () => {
      const payload = JSON.stringify({
        entity: 'event',
        account_id: 'acc_test',
        event: 'payment_link.paid',
        contains: ['payment_link'],
        payload: {
          payment_link: {
            entity: {
              id: 'plink_dup',
              status: 'paid',
              amount: 50000,
              amount_paid: 50000,
            },
          },
        },
      });

      razorpay.verifyWebhookSignature.mockReturnValue(true);
      // Return null = duplicate event
      repository.recordWebhookEvent.mockResolvedValue(null);

      await service.handleRazorpayWebhook(payload, 'valid_sig');

      // Should not process anything after idempotency check
      expect(repository.findPaymentByLinkId).not.toHaveBeenCalled();
      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // initiateRefund
  // ─────────────────────────────────────────────

  describe('initiateRefund', () => {
    it('should process refund within policy limits', async () => {
      const dto: InitiateRefundDto = {
        transactionId: PAYMENT_ID,
        amountPaise: 25000, // 250 rupees
        reason: 'Customer request',
      };

      const successPayment = createMockPayment({
        status: 'SUCCESS',
        gateway_payment_id: 'pay_gw123',
        amount: { toNumber: () => 500, toString: () => '500.00' },
      });

      repository.getPayment.mockResolvedValue(successPayment as never);

      razorpay.createRefund.mockResolvedValue({
        id: 'rfnd_test',
        paymentId: 'pay_gw123',
        amountPaise: 25000,
        status: 'processed',
      });

      const mockRefund = createMockRefund();
      repository.createRefund.mockResolvedValue(mockRefund as never);

      const result = await service.initiateRefund(BUSINESS_ID, dto);

      expect(result.id).toBe(REFUND_ID);
      expect(result.requiresApproval).toBe(false);

      // Verify Razorpay was called for refund
      expect(razorpay.createRefund).toHaveBeenCalledWith('pay_gw123', 25000);

      // Verify refund record was created
      expect(repository.createRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          paymentId: PAYMENT_ID,
          amountRupees: 250,
          requiresApproval: false,
          reason: 'Customer request',
        }),
      );

      // Verify refund event was emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.refund.initiated',
        expect.objectContaining({
          type: 'payment.refund.initiated',
          refundId: REFUND_ID,
          amountPaise: 25000,
        }),
      );
    });

    it('should route to HITL when refund exceeds policy limit', async () => {
      const dto: InitiateRefundDto = {
        transactionId: PAYMENT_ID,
        amountPaise: 2_000_000, // 20,000 rupees — exceeds 10k limit
        reason: 'Large refund',
      };

      const successPayment = createMockPayment({
        status: 'SUCCESS',
        gateway_payment_id: 'pay_gw123',
        amount: { toNumber: () => 25000, toString: () => '25000.00' },
      });

      repository.getPayment.mockResolvedValue(successPayment as never);

      const mockRefund = createMockRefund({ requires_approval: true });
      repository.createRefund.mockResolvedValue(mockRefund as never);

      const result = await service.initiateRefund(BUSINESS_ID, dto);

      // Should NOT call Razorpay for refund — routes to HITL instead
      expect(razorpay.createRefund).not.toHaveBeenCalled();

      // Should create refund with requires_approval=true
      expect(repository.createRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresApproval: true,
        }),
      );

      expect(result.requiresApproval).toBe(true);
    });

    it('should reject refund exceeding original payment amount', async () => {
      const dto: InitiateRefundDto = {
        transactionId: PAYMENT_ID,
        amountPaise: 100000, // 1000 rupees
        reason: 'Overcharge',
      };

      const successPayment = createMockPayment({
        status: 'SUCCESS',
        amount: { toNumber: () => 500, toString: () => '500.00' },
      });

      repository.getPayment.mockResolvedValue(successPayment as never);

      await expect(
        service.initiateRefund(BUSINESS_ID, dto),
      ).rejects.toThrow(BadRequestException);

      expect(razorpay.createRefund).not.toHaveBeenCalled();
      expect(repository.createRefund).not.toHaveBeenCalled();
    });

    it('should reject refund for non-success payment', async () => {
      const dto: InitiateRefundDto = {
        transactionId: PAYMENT_ID,
        amountPaise: 10000,
        reason: 'Test',
      };

      const pendingPayment = createMockPayment({ status: 'PENDING' });
      repository.getPayment.mockResolvedValue(pendingPayment as never);

      await expect(
        service.initiateRefund(BUSINESS_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when payment does not exist', async () => {
      const dto: InitiateRefundDto = {
        transactionId: PAYMENT_ID,
        amountPaise: 10000,
        reason: 'Test',
      };

      repository.getPayment.mockResolvedValue(null);

      await expect(
        service.initiateRefund(BUSINESS_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // confirmCODPayment
  // ─────────────────────────────────────────────

  describe('confirmCODPayment', () => {
    it('should record COD payment and emit payment.success', async () => {
      const dto: ConfirmCODDto = {
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        amountPaise: 199900,
        collectedBy: 'delivery_agent_1',
      };

      const codPayment = createMockPayment({
        gateway: 'MANUAL',
        amount: { toNumber: () => 1999, toString: () => '1999.00' },
      });

      repository.createPayment.mockResolvedValue(codPayment as never);

      const updatedPayment = createMockPayment({
        ...codPayment,
        status: 'SUCCESS',
        method: 'COD',
      });

      repository.updatePaymentStatus.mockResolvedValue(updatedPayment as never);

      const result = await service.confirmCODPayment(BUSINESS_ID, dto);

      expect(result.id).toBe(PAYMENT_ID);

      // Verify payment was created with MANUAL gateway
      expect(repository.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          orderId: ORDER_ID,
          gateway: PaymentGateway.MANUAL,
          metadata: expect.objectContaining({
            collectedBy: 'delivery_agent_1',
            type: 'COD',
          }),
        }),
      );

      // Verify status was updated to SUCCESS with COD method
      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.SUCCESS,
          method: 'COD',
        }),
      );

      // Verify payment.success event was emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.success',
        expect.objectContaining({
          type: 'payment.success',
          paymentId: PAYMENT_ID,
          amountPaise: 199900,
          gatewayPaymentId: 'MANUAL_COD',
        }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // Event listener: order.created
  // ─────────────────────────────────────────────

  describe('handleOrderCreated', () => {
    it('should auto-create payment link for order.created event', async () => {
      const event: OrderCreatedEvent = {
        type: 'order.created',
        id: 'evt_1',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-1',
        orderId: ORDER_ID,
        orderNumber: 'ORD-2024-00001',
        clientId: CLIENT_ID,
        totalPaise: 99900,
        currency: 'INR',
        lineItemCount: 2,
      };

      razorpay.createPaymentLink.mockResolvedValue({
        id: 'plink_auto',
        shortUrl: 'https://rzp.io/auto',
        url: 'https://rzp.io/auto/full',
        status: 'created',
        amountPaise: 99900,
      });

      repository.createPayment.mockResolvedValue(createMockPayment() as never);

      await service.handleOrderCreated(event);

      // Verify Razorpay was called with correct amount
      expect(razorpay.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({
          amountPaise: 99900,
          description: 'Payment for order ORD-2024-00001',
        }),
      );

      // Verify payment record was created
      expect(repository.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          orderId: ORDER_ID,
          clientId: CLIENT_ID,
        }),
      );

      // Verify payment.created event was emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.created',
        expect.objectContaining({
          type: 'payment.created',
          orderId: ORDER_ID,
        }),
      );
    });

    it('should not throw when auto-create fails (logs error)', async () => {
      const event: OrderCreatedEvent = {
        type: 'order.created',
        id: 'evt_2',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'gs-test-2',
        orderId: ORDER_ID,
        orderNumber: 'ORD-2024-00002',
        clientId: CLIENT_ID,
        totalPaise: 50000,
        currency: 'INR',
        lineItemCount: 1,
      };

      razorpay.createPaymentLink.mockRejectedValue(
        new Error('Razorpay API unavailable'),
      );

      // Should not throw — errors are caught and logged
      await expect(
        service.handleOrderCreated(event),
      ).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────
  // getPaymentSummaryForOrder
  // ─────────────────────────────────────────────

  describe('getPaymentSummaryForOrder', () => {
    it('should return correct aggregation in paise', async () => {
      repository.getPaymentSummaryForOrder.mockResolvedValue({
        paidRupees: 1000,
        pendingRupees: 500,
        refundedRupees: 200,
      });

      const result = await service.getPaymentSummaryForOrder(
        BUSINESS_ID,
        ORDER_ID,
      );

      expect(result).toEqual({
        paidPaise: 100000,
        pendingPaise: 50000,
        refundedPaise: 20000,
        currency: 'INR',
        orderId: ORDER_ID,
      });

      expect(repository.getPaymentSummaryForOrder).toHaveBeenCalledWith(
        BUSINESS_ID,
        ORDER_ID,
      );
    });

    it('should return zeros when no payments exist', async () => {
      repository.getPaymentSummaryForOrder.mockResolvedValue({
        paidRupees: 0,
        pendingRupees: 0,
        refundedRupees: 0,
      });

      const result = await service.getPaymentSummaryForOrder(
        BUSINESS_ID,
        ORDER_ID,
      );

      expect(result.paidPaise).toBe(0);
      expect(result.pendingPaise).toBe(0);
      expect(result.refundedPaise).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // cancelPaymentLink
  // ─────────────────────────────────────────────

  describe('cancelPaymentLink', () => {
    it('should cancel a pending payment link', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING' }) as never,
      );

      const cancelled = createMockPayment({ status: 'EXPIRED' });
      repository.updatePaymentStatus.mockResolvedValue(cancelled as never);

      const result = await service.cancelPaymentLink(BUSINESS_ID, PAYMENT_ID);

      expect(result.status).toBe('EXPIRED');
      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.EXPIRED,
          failureReason: 'Cancelled by user',
        }),
      );
    });

    it('should reject cancellation of SUCCESS payment', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      await expect(
        service.cancelPaymentLink(BUSINESS_ID, PAYMENT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for missing payment', async () => {
      repository.getPayment.mockResolvedValue(null);

      await expect(
        service.cancelPaymentLink(BUSINESS_ID, PAYMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // getRefund
  // ─────────────────────────────────────────────

  describe('getRefund', () => {
    it('should return refund when found', async () => {
      repository.getRefund.mockResolvedValue(createMockRefund() as never);

      const result = await service.getRefund(BUSINESS_ID, REFUND_ID);

      expect(result.id).toBe(REFUND_ID);
      expect(result.paymentId).toBe(PAYMENT_ID);
    });

    it('should throw NotFoundException when refund not found', async () => {
      repository.getRefund.mockResolvedValue(null);

      await expect(
        service.getRefund(BUSINESS_ID, REFUND_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // Gateway selection (Razorpay vs Stripe)
  // ─────────────────────────────────────────────

  describe('createPaymentLink — gateway selection', () => {
    it('should route INR to Razorpay', async () => {
      razorpay.createPaymentLink.mockResolvedValue({
        id: 'plink_inr',
        shortUrl: 'https://rzp.io/inr',
        url: 'https://rzp.io/inr',
        status: 'created',
        amountPaise: 50000,
      });
      repository.createPayment.mockResolvedValue(createMockPayment() as never);

      await service.createPaymentLink(BUSINESS_ID, {
        clientId: CLIENT_ID,
        amountPaise: 50000,
        currency: 'INR',
      });

      expect(razorpay.createPaymentLink).toHaveBeenCalled();
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
      expect(repository.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ gateway: PaymentGateway.RAZORPAY, currency: 'INR' }),
      );
    });

    it('should route non-INR currency to Stripe', async () => {
      stripe.createCheckoutSession.mockResolvedValue({
        id: 'cs_test_usd',
        url: 'https://checkout.stripe.com/usd',
        status: 'open',
        amountMinor: 5000,
      });
      repository.createPayment.mockResolvedValue(
        createMockPayment({ gateway: 'STRIPE', currency: 'USD' }) as never,
      );

      await service.createPaymentLink(BUSINESS_ID, {
        clientId: CLIENT_ID,
        amountPaise: 5000,
        currency: 'USD',
        customerEmail: 'buyer@example.com',
      });

      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: 5000, currency: 'USD' }),
      );
      expect(razorpay.createPaymentLink).not.toHaveBeenCalled();
      expect(repository.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ gateway: PaymentGateway.STRIPE, currency: 'USD' }),
      );
    });

    it('should honour an explicit gateway override', async () => {
      stripe.createCheckoutSession.mockResolvedValue({
        id: 'cs_test_override',
        url: 'https://checkout.stripe.com/override',
        status: 'open',
        amountMinor: 50000,
      });
      repository.createPayment.mockResolvedValue(
        createMockPayment({ gateway: 'STRIPE' }) as never,
      );

      await service.createPaymentLink(BUSINESS_ID, {
        clientId: CLIENT_ID,
        amountPaise: 50000,
        currency: 'INR',
        gateway: PaymentGateway.STRIPE,
      });

      expect(stripe.createCheckoutSession).toHaveBeenCalled();
      expect(razorpay.createPaymentLink).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Stripe webhook
  // ─────────────────────────────────────────────

  describe('handleStripeWebhook', () => {
    const completedPayload = JSON.stringify({
      id: 'evt_stripe_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_usd',
          object: 'checkout.session',
          amount_total: 5000,
          currency: 'usd',
          status: 'complete',
          payment_status: 'paid',
          payment_intent: 'pi_test_123',
          payment_method_types: ['card'],
        },
      },
    });

    it('should mark payment SUCCESS on checkout.session.completed', async () => {
      stripe.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_s1' });
      repository.findPaymentByLinkId.mockResolvedValue(
        createMockPayment({ gateway: 'STRIPE', currency: 'USD' }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      await service.handleStripeWebhook(completedPayload, 't=1,v1=sig');

      expect(stripe.verifyWebhookSignature).toHaveBeenCalledWith(
        completedPayload,
        't=1,v1=sig',
      );
      expect(repository.recordWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'STRIPE', externalId: 'evt_stripe_1' }),
      );
      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({
          status: PaymentStatus.SUCCESS,
          gatewayPaymentId: 'pi_test_123',
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.success',
        expect.objectContaining({ type: 'payment.success', paymentId: PAYMENT_ID }),
      );
      expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_s1');
    });

    it('should reject Stripe webhook with invalid signature', async () => {
      stripe.verifyWebhookSignature.mockReturnValue(false);

      await expect(
        service.handleStripeWebhook(completedPayload, 'bad'),
      ).rejects.toThrow(UnauthorizedException);

      expect(repository.recordWebhookEvent).not.toHaveBeenCalled();
    });

    it('should skip duplicate Stripe webhook events', async () => {
      stripe.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue(null);

      await service.handleStripeWebhook(completedPayload, 't=1,v1=sig');

      expect(repository.findPaymentByLinkId).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Refunds via Stripe
  // ─────────────────────────────────────────────

  describe('initiateRefund — Stripe', () => {
    it('should refund a Stripe payment via the Stripe gateway', async () => {
      const stripePayment = createMockPayment({
        status: 'SUCCESS',
        gateway: 'STRIPE',
        currency: 'USD',
        gateway_payment_id: 'pi_test_123',
        amount: { toNumber: () => 50, toString: () => '50.00' },
      });
      repository.getPayment.mockResolvedValue(stripePayment as never);
      stripe.createRefund.mockResolvedValue({
        id: 're_test',
        paymentIntentId: 'pi_test_123',
        amountMinor: 2500,
        status: 'succeeded',
      });
      repository.createRefund.mockResolvedValue(createMockRefund() as never);

      await service.initiateRefund(BUSINESS_ID, {
        transactionId: PAYMENT_ID,
        amountPaise: 2500,
        reason: 'Customer request',
      });

      expect(stripe.createRefund).toHaveBeenCalledWith('pi_test_123', 2500);
      expect(razorpay.createRefund).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────

  describe('reconcilePayment', () => {
    it('should mark a Razorpay payment SUCCESS when gateway reports paid', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING', gateway: 'RAZORPAY' }) as never,
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        id: 'plink_test123',
        status: 'paid',
        amountPaidPaise: 50000,
        paymentId: 'pay_recon',
      });
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      const result = await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

      expect(result.changed).toBe(true);
      expect(result.currentStatus).toBe(PaymentStatus.SUCCESS);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.success',
        expect.objectContaining({ paymentId: PAYMENT_ID }),
      );
    });

    it('should mark a Stripe payment EXPIRED when session expired', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING', gateway: 'STRIPE' }) as never,
      );
      stripe.fetchSessionStatus.mockResolvedValue({
        id: 'plink_test123',
        status: 'expired',
        paymentStatus: 'unpaid',
      });
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({ status: 'EXPIRED' }) as never,
      );

      const result = await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

      expect(result.changed).toBe(true);
      expect(result.currentStatus).toBe(PaymentStatus.EXPIRED);
    });

    it('should not change a payment already in a terminal state', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      const result = await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

      expect(result.changed).toBe(false);
      expect(razorpay.fetchPaymentLinkStatus).not.toHaveBeenCalled();
      expect(stripe.fetchSessionStatus).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for a missing payment', async () => {
      repository.getPayment.mockResolvedValue(null);

      await expect(
        service.reconcilePayment(BUSINESS_ID, PAYMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('reconcilePendingPayments', () => {
    it('should reconcile all pending payments and summarise', async () => {
      repository.listReconcilablePayments.mockResolvedValue([
        createMockPayment({ id: PAYMENT_ID, status: 'PENDING', gateway: 'RAZORPAY' }),
      ] as never);
      // reconcilePayment re-fetches the payment by id
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING', gateway: 'RAZORPAY' }) as never,
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        id: 'plink_test123',
        status: 'created',
        amountPaidPaise: 0,
      });

      const summary = await service.reconcilePendingPayments(BUSINESS_ID);

      expect(summary.checked).toBe(1);
      expect(summary.updated).toBe(0);
      expect(summary.results).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────
  // BRANCH COVERAGE — webhook routing, fallbacks, mappers
  // ─────────────────────────────────────────────

  describe('Razorpay webhook routing', () => {
    const rzpPayload = (event: string, payload: Record<string, unknown>) =>
      JSON.stringify({ entity: 'event', account_id: 'acc', event, payload });

    beforeEach(() => {
      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_1' });
      repository.markWebhookProcessed.mockResolvedValue(undefined as never);
    });

    it('accepts a raw Buffer body', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(null as never);
      const buf = Buffer.from(
        rzpPayload('payment_link.paid', { payment_link: { entity: { id: 'plink_x' } } }),
        'utf8',
      );

      await service.handleRazorpayWebhook(buf, 'sig');

      expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_1');
    });

    it.each(['payment.authorized', 'payment.captured'])(
      'routes %s to the capture handler',
      async (event) => {
        repository.findPaymentByGatewayId.mockResolvedValue(
          createMockPayment({ status: 'PENDING' }) as never,
        );
        repository.updatePaymentStatus.mockResolvedValue(
          createMockPayment({ status: 'SUCCESS' }) as never,
        );

        await service.handleRazorpayWebhook(
          rzpPayload(event, { payment: { entity: { id: 'pay_1', method: 'card' } } }),
          'sig',
        );

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'payment.success',
          expect.objectContaining({ gatewayPaymentId: 'pay_1' }),
        );
      },
    );

    it('ignores an unhandled event type but still marks it processed', async () => {
      await service.handleRazorpayWebhook(rzpPayload('order.paid', {}), 'sig');

      expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_1');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rethrows after logging a non-Error thrown by a handler', async () => {
      repository.findPaymentByLinkId.mockImplementation(() => {
        throw 'gateway exploded';
      });

      await expect(
        service.handleRazorpayWebhook(
          rzpPayload('payment_link.paid', { payment_link: { entity: { id: 'plink_x' } } }),
          'sig',
        ),
      ).rejects.toBe('gateway exploded');
      expect(repository.markWebhookProcessed).not.toHaveBeenCalled();
    });

    it('derives the idempotency key from a payment_link when there is no payment entity', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(null as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment_link.paid', { payment_link: { entity: { id: 'plink_k' } } }),
        'sig',
      );

      expect(repository.recordWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'payment_link.paid_plink_k' }),
      );
    });

    it('derives the idempotency key from a refund entity', async () => {
      repository.findRefundByGatewayId.mockResolvedValue(null as never);

      await service.handleRazorpayWebhook(
        rzpPayload('refund.processed', { refund: { entity: { id: 'rfnd_k' } } }),
        'sig',
      );

      expect(repository.recordWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'refund.processed_rfnd_k' }),
      );
    });

    it('falls back to "unknown" when the payload carries no entity at all', async () => {
      await service.handleRazorpayWebhook(rzpPayload('order.paid', {}), 'sig');

      expect(repository.recordWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'order.paid_unknown' }),
      );
    });
  });

  describe('Razorpay webhook handlers (missing / unmatched entities)', () => {
    const rzpPayload = (event: string, payload: Record<string, unknown>) =>
      JSON.stringify({ entity: 'event', account_id: 'acc', event, payload });

    beforeEach(() => {
      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_1' });
      repository.markWebhookProcessed.mockResolvedValue(undefined as never);
    });

    it('ignores payment_link.paid with no payment_link entity', async () => {
      await service.handleRazorpayWebhook(rzpPayload('payment_link.paid', {}), 'sig');
      expect(repository.findPaymentByLinkId).not.toHaveBeenCalled();
    });

    it('ignores payment_link.paid when no local payment matches the link', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(null as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment_link.paid', { payment_link: { entity: { id: 'plink_x' } } }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('records nulls when payment_link.paid carries no payment entity', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        createMockPayment({ order_id: null }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment_link.paid', { payment_link: { entity: { id: 'plink_x' } } }),
        'sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ method: null, gatewayPaymentId: null }),
      );
      const event = eventEmitter.emit.mock.calls.find((c) => c[0] === 'payment.success');
      expect(event?.[1]).toMatchObject({ orderId: undefined, gatewayPaymentId: '' });
    });

    it('ignores payment.captured with no payment entity', async () => {
      await service.handleRazorpayWebhook(rzpPayload('payment.captured', {}), 'sig');
      expect(repository.findPaymentByGatewayId).not.toHaveBeenCalled();
    });

    it('falls back to the gateway order id when the payment id does not match', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(null as never);
      repository.findPaymentByGatewayOrderId.mockResolvedValue(
        createMockPayment({ status: 'PENDING', order_id: null }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment.captured', {
          payment: { entity: { id: 'pay_1', order_id: 'order_rzp_1' } },
        }),
        'sig',
      );

      expect(repository.findPaymentByGatewayOrderId).toHaveBeenCalledWith('order_rzp_1');
      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ method: null }),
      );
    });

    it('ignores payment.captured when nothing matches', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(null as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment.captured', { payment: { entity: { id: 'pay_1' } } }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('skips a redelivered payment.captured for an already-SUCCESS payment', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      await service.handleRazorpayWebhook(
        rzpPayload('payment.captured', { payment: { entity: { id: 'pay_1' } } }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('ignores payment.failed with no payment entity', async () => {
      await service.handleRazorpayWebhook(rzpPayload('payment.failed', {}), 'sig');
      expect(repository.findPaymentByGatewayId).not.toHaveBeenCalled();
    });

    it('ignores payment.failed when nothing matches', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(null as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment.failed', { payment: { entity: { id: 'pay_1' } } }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it.each([
      [{ error_description: 'card declined' }, 'card declined'],
      [{ error_code: 'BAD_REQUEST_ERROR' }, 'BAD_REQUEST_ERROR'],
      [{}, 'Payment failed'],
    ])('derives the failure reason from %o', async (errorFields, expected) => {
      repository.findPaymentByGatewayId.mockResolvedValue(null as never);
      repository.findPaymentByGatewayOrderId.mockResolvedValue(
        createMockPayment({ order_id: null }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.handleRazorpayWebhook(
        rzpPayload('payment.failed', {
          payment: { entity: { id: 'pay_1', order_id: 'order_1', ...errorFields } },
        }),
        'sig',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({ reason: expected, orderId: undefined }),
      );
    });

    it('ignores refund.processed with no refund entity', async () => {
      await service.handleRazorpayWebhook(rzpPayload('refund.processed', {}), 'sig');
      expect(repository.findRefundByGatewayId).not.toHaveBeenCalled();
    });
  });

  describe('Stripe webhook routing', () => {
    const stripePayload = (type: string, object: Record<string, unknown>) =>
      JSON.stringify({ id: 'evt_1', type, data: { object } });

    beforeEach(() => {
      stripe.verifyWebhookSignature.mockReturnValue(true);
      repository.recordWebhookEvent.mockResolvedValue({ id: 'wh_1' });
      repository.markWebhookProcessed.mockResolvedValue(undefined as never);
    });

    it('accepts a raw Buffer body', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(null as never);
      const buf = Buffer.from(
        stripePayload('checkout.session.completed', { id: 'cs_1' }),
        'utf8',
      );

      await service.handleStripeWebhook(buf, 'sig');

      expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_1');
    });

    it.each(['charge.refunded', 'refund.updated'])(
      'logs %s without touching any payment',
      async (type) => {
        await service.handleStripeWebhook(stripePayload(type, { id: 'ch_1' }), 'sig');

        expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
        expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_1');
      },
    );

    it('ignores an unhandled Stripe event type', async () => {
      await service.handleStripeWebhook(stripePayload('customer.created', {}), 'sig');
      expect(repository.markWebhookProcessed).toHaveBeenCalledWith('wh_1');
    });

    it('rethrows after logging a non-Error thrown by a handler', async () => {
      repository.findPaymentByLinkId.mockImplementation(() => {
        throw 'stripe exploded';
      });

      await expect(
        service.handleStripeWebhook(
          stripePayload('checkout.session.completed', { id: 'cs_1' }),
          'sig',
        ),
      ).rejects.toBe('stripe exploded');
    });

    it('ignores checkout.session.completed when no payment matches the session', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(null as never);

      await service.handleStripeWebhook(
        stripePayload('checkout.session.completed', { id: 'cs_1' }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('skips a redelivered checkout.session.completed for an already-SUCCESS payment', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      await service.handleStripeWebhook(
        stripePayload('checkout.session.completed', { id: 'cs_1' }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it('records nulls when the session has no payment_intent or method types', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        createMockPayment({ status: 'PENDING', order_id: null, gateway: 'STRIPE' }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.handleStripeWebhook(
        stripePayload('checkout.session.completed', { id: 'cs_1' }),
        'sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ method: null, gatewayPaymentId: null }),
      );
      const event = eventEmitter.emit.mock.calls.find((c) => c[0] === 'payment.success');
      expect(event?.[1]).toMatchObject({ orderId: undefined, gatewayPaymentId: '' });
    });

    it('ignores checkout.session.expired when no payment matches', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(null as never);

      await service.handleStripeWebhook(
        stripePayload('checkout.session.expired', { id: 'cs_1' }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it.each(['SUCCESS', 'EXPIRED'])(
      'leaves a %s payment alone on checkout.session.expired',
      async (status) => {
        repository.findPaymentByLinkId.mockResolvedValue(
          createMockPayment({ status }) as never,
        );

        await service.handleStripeWebhook(
          stripePayload('checkout.session.expired', { id: 'cs_1' }),
          'sig',
        );

        expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
      },
    );

    it('marks a pending payment EXPIRED on checkout.session.expired', async () => {
      repository.findPaymentByLinkId.mockResolvedValue(
        createMockPayment({ status: 'PENDING' }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.handleStripeWebhook(
        stripePayload('checkout.session.expired', { id: 'cs_1' }),
        'sig',
      );

      expect(repository.updatePaymentStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        PAYMENT_ID,
        expect.objectContaining({ status: PaymentStatus.EXPIRED }),
      );
    });

    it('ignores payment_intent.payment_failed when no payment matches', async () => {
      repository.findPaymentByGatewayId.mockResolvedValue(null as never);

      await service.handleStripeWebhook(
        stripePayload('payment_intent.payment_failed', { id: 'pi_1' }),
        'sig',
      );

      expect(repository.updatePaymentStatus).not.toHaveBeenCalled();
    });

    it.each([
      [{ last_payment_error: { message: 'card_declined message' } }, 'card_declined message'],
      [{ last_payment_error: { code: 'card_declined' } }, 'card_declined'],
      [{}, 'Payment failed'],
    ])('derives the Stripe failure reason from %o', async (errorFields, expected) => {
      repository.findPaymentByGatewayId.mockResolvedValue(
        createMockPayment({ order_id: null, gateway: 'STRIPE' }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.handleStripeWebhook(
        stripePayload('payment_intent.payment_failed', { id: 'pi_1', ...errorFields }),
        'sig',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({ reason: expected, orderId: undefined }),
      );
    });
  });

  describe('reconcilePayment (remaining gateway outcomes)', () => {
    it.each(['cancelled', 'expired'])(
      'marks a Razorpay payment EXPIRED when the link is %s',
      async (status) => {
        repository.getPayment.mockResolvedValue(
          createMockPayment({ status: 'PENDING', gateway: 'RAZORPAY' }) as never,
        );
        razorpay.fetchPaymentLinkStatus.mockResolvedValue({
          id: 'plink_test123',
          status,
          amountPaidPaise: 0,
        } as never);
        repository.updatePaymentStatus.mockResolvedValue(
          createMockPayment({ status: 'EXPIRED' }) as never,
        );

        const result = await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

        expect(result.currentStatus).toBe(PaymentStatus.EXPIRED);
      },
    );

    it('marks a Stripe payment SUCCESS when the session reports paid', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING', gateway: 'STRIPE', order_id: null }) as never,
      );
      stripe.fetchSessionStatus.mockResolvedValue({
        id: 'cs_1',
        status: 'complete',
        paymentStatus: 'paid',
        paymentIntentId: 'pi_recon',
      } as never);
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({ status: 'SUCCESS' }) as never,
      );

      const result = await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

      expect(result.currentStatus).toBe(PaymentStatus.SUCCESS);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.success',
        expect.objectContaining({ gatewayPaymentId: 'pi_recon', orderId: undefined }),
      );
    });

    it('records an empty gateway id when the paid link reports no payment id', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING', gateway: 'RAZORPAY' }) as never,
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        id: 'plink_test123',
        status: 'paid',
        amountPaidPaise: 50000,
      } as never);
      repository.updatePaymentStatus.mockResolvedValue(createMockPayment() as never);

      await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.success',
        expect.objectContaining({ gatewayPaymentId: '' }),
      );
    });

    it('swallows a non-Error thrown by the gateway and leaves the status unchanged', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ status: 'PENDING', gateway: 'RAZORPAY' }) as never,
      );
      razorpay.fetchPaymentLinkStatus.mockImplementation(() => {
        throw 'gateway down';
      });

      const result = await service.reconcilePayment(BUSINESS_ID, PAYMENT_ID);

      expect(result.changed).toBe(false);
      expect(result.currentStatus).toBe(PaymentStatus.PENDING);
    });
  });

  describe('remaining service branches', () => {
    it('throws NotFoundException when fetching an unknown payment link', async () => {
      repository.getPayment.mockResolvedValue(null as never);

      await expect(service.getPaymentLink(BUSINESS_ID, PAYMENT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('threads the orderId into the Stripe checkout metadata', async () => {
      stripe.createCheckoutSession.mockResolvedValue({
        id: 'cs_meta',
        url: 'https://checkout.stripe.com/cs_meta',
      } as never);
      repository.createPayment.mockResolvedValue(
        createMockPayment({ gateway: 'STRIPE' }) as never,
      );

      await service.createPaymentLink(BUSINESS_ID, {
        clientId: CLIENT_ID,
        orderId: ORDER_ID,
        amountPaise: 5000,
        currency: 'USD',
        description: 'Order',
      } as CreatePaymentLinkDto);

      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ orderId: ORDER_ID }),
        }),
      );
    });

    it('wraps a non-Error gateway refund failure in a BadRequestException', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({
          status: 'SUCCESS',
          gateway: 'RAZORPAY',
          gateway_payment_id: 'pay_1',
        }) as never,
      );
      repository.sumCompletedRefundsForPayment.mockResolvedValue(0);
      razorpay.createRefund.mockImplementation(() => {
        throw 'refund exploded';
      });

      await expect(
        service.initiateRefund(BUSINESS_ID, {
          transactionId: PAYMENT_ID,
          amountPaise: 10000,
          reason: 'Customer request',
        } as InitiateRefundDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('omits the orderId from the refund record when the payment has none', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({
          status: 'SUCCESS',
          gateway: 'RAZORPAY',
          gateway_payment_id: 'pay_1',
          order_id: null,
        }) as never,
      );
      repository.sumCompletedRefundsForPayment.mockResolvedValue(0);
      razorpay.createRefund.mockResolvedValue({ id: 'rfnd_1' } as never);
      repository.createRefund.mockResolvedValue(
        createMockRefund({ order_id: null }) as never,
      );

      await service.initiateRefund(BUSINESS_ID, {
        transactionId: PAYMENT_ID,
        amountPaise: 10000,
        reason: 'Customer request',
      } as InitiateRefundDto);

      expect(repository.createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: undefined }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.refund.initiated',
        expect.objectContaining({ orderId: undefined }),
      );
    });

    it('swallows a non-Error thrown while auto-creating a payment link', async () => {
      repository.createPayment.mockImplementation(() => {
        throw 'boom';
      });

      await expect(
        service.handleOrderCreated({
          id: 'evt',
          type: 'order.created',
          timestamp: new Date().toISOString(),
          businessId: BUSINESS_ID,
          correlationId: 'corr',
          orderId: ORDER_ID,
          orderNumber: 'ORD-1',
          clientId: CLIENT_ID,
          totalPaise: 50000,
        } as OrderCreatedEvent),
      ).resolves.toBeUndefined();
    });

    it('maps null timestamps on a payment to null DTO fields', async () => {
      repository.getPayment.mockResolvedValue(
        createMockPayment({ payment_link_expires_at: null }) as never,
      );

      const dto = await service.getPaymentLink(BUSINESS_ID, PAYMENT_ID);

      expect(dto.expiresAt).toBeNull();
    });

    it('maps every null lifecycle timestamp on a COD transaction', async () => {
      repository.createPayment.mockResolvedValue(
        createMockPayment({
          status: 'SUCCESS',
          method: 'COD',
          gateway: 'MANUAL',
          payment_link_expires_at: null,
          initiated_at: null,
          captured_at: null,
          failed_at: null,
        }) as never,
      );
      repository.updatePaymentStatus.mockResolvedValue(
        createMockPayment({
          status: 'SUCCESS',
          payment_link_expires_at: null,
          initiated_at: null,
          captured_at: null,
          failed_at: null,
        }) as never,
      );

      const dto = await service.confirmCODPayment(BUSINESS_ID, {
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        amountPaise: 50000,
      } as ConfirmCODDto);

      expect(dto.expiresAt).toBeNull();
      expect(dto.initiatedAt).toBeNull();
      expect(dto.capturedAt).toBeNull();
      expect(dto.failedAt).toBeNull();
    });
  });

});
