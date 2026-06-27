import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { PaymentRepository } from './payment.repository';
import { CreateInvoiceDto } from './dto';
import { InvoiceStatus } from '@gosumo/shared';
import type { PaymentSuccessEvent } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CLIENT_ID = '00000000-0000-4000-a000-000000000002';
const PAYMENT_ID = '00000000-0000-4000-a000-000000000003';
const ORDER_ID = '00000000-0000-4000-a000-000000000004';
const INVOICE_ID = '00000000-0000-4000-a000-000000000009';

function dec(value: number) {
  return { toNumber: () => value, toString: () => value.toFixed(2) };
}

function createMockInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    business_id: BUSINESS_ID,
    order_id: ORDER_ID,
    client_id: CLIENT_ID,
    payment_id: PAYMENT_ID,
    invoice_number: 'INV-2026-000001',
    status: 'DRAFT',
    currency: 'INR',
    subtotal: dec(998),
    tax_amount: dec(90),
    discount_amount: dec(50),
    total: dec(1038),
    line_items: [
      { description: 'Widget', quantity: 2, unitAmountMinor: 49900, amountMinor: 99800 },
    ],
    notes: 'Thank you',
    issued_at: null,
    due_at: null,
    paid_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

describe('InvoiceService', () => {
  let service: InvoiceService;
  let repository: jest.Mocked<PaymentRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository = {
      createInvoice: jest.fn(),
      getInvoice: jest.fn(),
      findInvoiceByPaymentId: jest.fn(),
      listInvoices: jest.fn(),
      updateInvoiceStatus: jest.fn(),
      countInvoicesForYear: jest.fn(),
    };
    const mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: PaymentRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<InvoiceService>(InvoiceService);
    repository = module.get(PaymentRepository);
    eventEmitter = module.get(EventEmitter2);
  });

  // ─────────────────────────────────────────────
  // createInvoice
  // ─────────────────────────────────────────────

  describe('createInvoice', () => {
    it('should compute totals, number the invoice, and emit invoice.created', async () => {
      const dto: CreateInvoiceDto = {
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        paymentId: PAYMENT_ID,
        lineItems: [
          { description: 'Widget', quantity: 2, unitAmountPaise: 49900 },
        ],
        taxAmountPaise: 9000,
        discountAmountPaise: 5000,
        notes: 'Thank you',
      };

      repository.countInvoicesForYear.mockResolvedValue(0);
      repository.createInvoice.mockResolvedValue(createMockInvoice() as never);

      const result = await service.createInvoice(BUSINESS_ID, dto);

      // subtotal = 2 * 49900 = 99800 paise; total = 99800 + 9000 - 5000 = 103800
      expect(repository.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          subtotal: 998, // major units
          taxAmount: 90,
          discountAmount: 50,
          total: 1038,
          invoiceNumber: expect.stringMatching(/^INV-\d{4}-000001$/),
        }),
      );

      expect(result.invoiceNumber).toBe('INV-2026-000001');
      expect(result.totalPaise).toBe(103800);
      expect(result.lineItems[0]!.amountPaise).toBe(99800);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'invoice.created',
        expect.objectContaining({ type: 'invoice.created', totalPaise: 103800 }),
      );
    });

    it('should floor the total at zero when discount exceeds subtotal', async () => {
      const dto: CreateInvoiceDto = {
        clientId: CLIENT_ID,
        lineItems: [{ description: 'Item', quantity: 1, unitAmountPaise: 1000 }],
        discountAmountPaise: 5000,
      };
      repository.countInvoicesForYear.mockResolvedValue(0);
      repository.createInvoice.mockResolvedValue(
        createMockInvoice({ total: dec(0), subtotal: dec(10), discount_amount: dec(50) }) as never,
      );

      await service.createInvoice(BUSINESS_ID, dto);

      expect(repository.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ total: 0 }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // getInvoice
  // ─────────────────────────────────────────────

  describe('getInvoice', () => {
    it('should return an invoice when found', async () => {
      repository.getInvoice.mockResolvedValue(createMockInvoice() as never);
      const result = await service.getInvoice(BUSINESS_ID, INVOICE_ID);
      expect(result.id).toBe(INVOICE_ID);
    });

    it('should throw NotFoundException when missing', async () => {
      repository.getInvoice.mockResolvedValue(null);
      await expect(service.getInvoice(BUSINESS_ID, INVOICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────
  // issueInvoice
  // ─────────────────────────────────────────────

  describe('issueInvoice', () => {
    it('should transition DRAFT → ISSUED and emit invoice.issued', async () => {
      repository.getInvoice.mockResolvedValue(createMockInvoice({ status: 'DRAFT' }) as never);
      repository.updateInvoiceStatus.mockResolvedValue(
        createMockInvoice({ status: 'ISSUED', issued_at: new Date() }) as never,
      );

      const result = await service.issueInvoice(BUSINESS_ID, INVOICE_ID);

      expect(repository.updateInvoiceStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        INVOICE_ID,
        expect.objectContaining({ status: InvoiceStatus.ISSUED }),
      );
      expect(result.status).toBe('ISSUED');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'invoice.issued',
        expect.objectContaining({ type: 'invoice.issued' }),
      );
    });

    it('should reject issuing a non-DRAFT invoice', async () => {
      repository.getInvoice.mockResolvedValue(createMockInvoice({ status: 'PAID' }) as never);
      await expect(service.issueInvoice(BUSINESS_ID, INVOICE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─────────────────────────────────────────────
  // markInvoicePaid
  // ─────────────────────────────────────────────

  describe('markInvoicePaid', () => {
    it('should mark an invoice PAID and emit invoice.paid', async () => {
      repository.getInvoice.mockResolvedValue(createMockInvoice({ status: 'ISSUED' }) as never);
      repository.updateInvoiceStatus.mockResolvedValue(
        createMockInvoice({ status: 'PAID', paid_at: new Date() }) as never,
      );

      const result = await service.markInvoicePaid(BUSINESS_ID, INVOICE_ID, PAYMENT_ID);

      expect(result.status).toBe('PAID');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'invoice.paid',
        expect.objectContaining({ type: 'invoice.paid', paymentId: PAYMENT_ID }),
      );
    });

    it('should reject marking a CANCELLED invoice as paid', async () => {
      repository.getInvoice.mockResolvedValue(
        createMockInvoice({ status: 'CANCELLED' }) as never,
      );
      await expect(
        service.markInvoicePaid(BUSINESS_ID, INVOICE_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────
  // renderInvoiceText
  // ─────────────────────────────────────────────

  describe('renderInvoiceText', () => {
    it('should render a plain-text invoice', async () => {
      repository.getInvoice.mockResolvedValue(createMockInvoice() as never);
      const text = await service.renderInvoiceText(BUSINESS_ID, INVOICE_ID);
      expect(text).toContain('INVOICE INV-2026-000001');
      expect(text).toContain('Widget × 2');
      expect(text).toContain('Total:');
    });
  });

  // ─────────────────────────────────────────────
  // payment.success listener
  // ─────────────────────────────────────────────

  describe('handlePaymentSuccess', () => {
    const event: PaymentSuccessEvent = {
      type: 'payment.success',
      id: 'evt_1',
      timestamp: new Date().toISOString(),
      businessId: BUSINESS_ID,
      correlationId: 'gs-1',
      paymentId: PAYMENT_ID,
      clientId: CLIENT_ID,
      amountPaise: 103800,
      currency: 'INR',
      status: 'SUCCESS' as never,
      gatewayPaymentId: 'pay_1',
    };

    it('should mark the linked invoice PAID', async () => {
      repository.findInvoiceByPaymentId.mockResolvedValue(
        createMockInvoice({ status: 'ISSUED' }) as never,
      );
      repository.getInvoice.mockResolvedValue(
        createMockInvoice({ status: 'ISSUED' }) as never,
      );
      repository.updateInvoiceStatus.mockResolvedValue(
        createMockInvoice({ status: 'PAID' }) as never,
      );

      await service.handlePaymentSuccess(event);

      expect(repository.updateInvoiceStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        INVOICE_ID,
        expect.objectContaining({ status: InvoiceStatus.PAID }),
      );
    });

    it('should no-op when no invoice is linked to the payment', async () => {
      repository.findInvoiceByPaymentId.mockResolvedValue(null);
      await service.handlePaymentSuccess(event);
      expect(repository.updateInvoiceStatus).not.toHaveBeenCalled();
    });

    it('should not throw if marking paid fails', async () => {
      repository.findInvoiceByPaymentId.mockResolvedValue(
        createMockInvoice({ status: 'ISSUED' }) as never,
      );
      repository.getInvoice.mockRejectedValue(new Error('db down'));
      await expect(service.handlePaymentSuccess(event)).resolves.not.toThrow();
    });
  });
});
