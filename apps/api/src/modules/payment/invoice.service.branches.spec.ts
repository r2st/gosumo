import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { InvoiceStatus } from '@gosumo/shared';
import type { PaymentSuccessEvent } from '@gosumo/shared';
import { InvoiceService } from './invoice.service';
import { PaymentRepository } from './payment.repository';
import { CreateInvoiceDto, ListInvoicesQueryDto } from './dto';

/**
 * Branch-focused companion to `invoice.service.spec.ts`.
 *
 * Covers the optional-field fallbacks (no tax/discount, an explicit due date,
 * a null `line_items` column), the three not-found guards, the
 * payment-id coalescing chains on `markInvoicePaid`, and `listInvoices`.
 */

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CLIENT_ID = '00000000-0000-4000-a000-000000000002';
const PAYMENT_ID = '00000000-0000-4000-a000-000000000003';
const ORDER_ID = '00000000-0000-4000-a000-000000000004';
const INVOICE_ID = '00000000-0000-4000-a000-000000000009';

function dec(value: number) {
  return { toNumber: () => value, toString: () => value.toFixed(2) };
}

function mockInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    business_id: BUSINESS_ID,
    order_id: ORDER_ID,
    client_id: CLIENT_ID,
    payment_id: PAYMENT_ID,
    invoice_number: 'INV-2026-000001',
    status: InvoiceStatus.ISSUED,
    currency: 'INR',
    subtotal: dec(1000),
    tax_amount: dec(0),
    discount_amount: dec(0),
    total: dec(1000),
    line_items: [
      { description: 'Widget', quantity: 1, unitAmountMinor: 100000, amountMinor: 100000 },
    ],
    notes: null,
    issued_at: null,
    due_at: null,
    paid_at: null,
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    updated_at: new Date('2026-08-01T00:00:00.000Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('InvoiceService — branch coverage', () => {
  let service: InvoiceService;
  let repository: {
    createInvoice: jest.Mock;
    getInvoice: jest.Mock;
    findInvoiceByPaymentId: jest.Mock;
    listInvoices: jest.Mock;
    updateInvoiceStatus: jest.Mock;
    countInvoicesForYear: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = {
      createInvoice: jest.fn(),
      getInvoice: jest.fn(),
      findInvoiceByPaymentId: jest.fn(),
      listInvoices: jest.fn(),
      updateInvoiceStatus: jest.fn(),
      countInvoicesForYear: jest.fn(),
    };
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: PaymentRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(InvoiceService);
    jest.spyOn(service['logger'], 'log').mockImplementation();
    jest.spyOn(service['logger'], 'error').mockImplementation();
  });

  // ─────────────────────────────────────────────
  // createInvoice — optional-field fallbacks
  // ─────────────────────────────────────────────

  describe('createInvoice', () => {
    it('treats an omitted tax and discount as zero', async () => {
      repository.countInvoicesForYear.mockResolvedValue(0);
      repository.createInvoice.mockImplementation(async () => mockInvoice());

      const dto: CreateInvoiceDto = {
        clientId: CLIENT_ID,
        lineItems: [{ description: 'Widget', quantity: 2, unitAmountPaise: 50000 }],
      } as CreateInvoiceDto;

      await service.createInvoice(BUSINESS_ID, dto);

      expect(repository.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'INR',
          subtotal: 1000,
          taxAmount: 0,
          discountAmount: 0,
          total: 1000,
          dueAt: undefined,
        }),
      );
    });

    it('converts an ISO dueAt into a Date', async () => {
      repository.countInvoicesForYear.mockResolvedValue(0);
      repository.createInvoice.mockImplementation(async () => mockInvoice());

      await service.createInvoice(BUSINESS_ID, {
        clientId: CLIENT_ID,
        lineItems: [{ description: 'Widget', quantity: 1, unitAmountPaise: 100000 }],
        dueAt: '2026-09-01T00:00:00.000Z',
      } as CreateInvoiceDto);

      const arg = repository.createInvoice.mock.calls[0][0];
      expect(arg.dueAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it('floors the total at zero when the discount exceeds subtotal + tax', async () => {
      repository.countInvoicesForYear.mockResolvedValue(0);
      repository.createInvoice.mockImplementation(async () => mockInvoice());

      await service.createInvoice(BUSINESS_ID, {
        clientId: CLIENT_ID,
        lineItems: [{ description: 'Widget', quantity: 1, unitAmountPaise: 10000 }],
        taxAmountPaise: 0,
        discountAmountPaise: 99999,
      } as CreateInvoiceDto);

      expect(repository.createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ total: 0 }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'invoice.created',
        expect.objectContaining({ totalPaise: 0 }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // listInvoices
  // ─────────────────────────────────────────────

  describe('listInvoices', () => {
    it('forwards every filter and maps each row to a DTO', async () => {
      repository.listInvoices.mockResolvedValue({
        data: [mockInvoice(), mockInvoice({ id: 'second' })],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const query: ListInvoicesQueryDto = {
        status: InvoiceStatus.ISSUED,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        page: 1,
        limit: 20,
      };

      const result = await service.listInvoices(BUSINESS_ID, query);

      expect(repository.listInvoices).toHaveBeenCalledWith(BUSINESS_ID, {
        status: InvoiceStatus.ISSUED,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        page: 1,
        limit: 20,
      });
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual(
        expect.objectContaining({ id: INVOICE_ID, invoiceNumber: 'INV-2026-000001' }),
      );
    });

    it('returns an empty page when the tenant has no invoices', async () => {
      repository.listInvoices.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      const result = await service.listInvoices(BUSINESS_ID, {} as ListInvoicesQueryDto);

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // Not-found guards
  // ─────────────────────────────────────────────

  describe('not-found guards', () => {
    it.each([
      ['issueInvoice', () => service.issueInvoice(BUSINESS_ID, INVOICE_ID)],
      ['markInvoicePaid', () => service.markInvoicePaid(BUSINESS_ID, INVOICE_ID)],
      ['renderInvoiceText', () => service.renderInvoiceText(BUSINESS_ID, INVOICE_ID)],
    ])('%s throws NotFoundException for an invoice outside the tenant', async (_name, call) => {
      repository.getInvoice.mockResolvedValue(null);

      await expect(call()).rejects.toThrow(NotFoundException);
      expect(repository.updateInvoiceStatus).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // markInvoicePaid — payment-id coalescing
  // ─────────────────────────────────────────────

  describe('markInvoicePaid', () => {
    it('keeps the invoice’s existing payment_id when no override is passed', async () => {
      repository.getInvoice.mockResolvedValue(mockInvoice({ payment_id: PAYMENT_ID }));
      repository.updateInvoiceStatus.mockResolvedValue(
        mockInvoice({ status: InvoiceStatus.PAID, payment_id: PAYMENT_ID }),
      );

      await service.markInvoicePaid(BUSINESS_ID, INVOICE_ID);

      expect(repository.updateInvoiceStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        INVOICE_ID,
        expect.objectContaining({ paymentId: PAYMENT_ID }),
      );
    });

    it('passes undefined when neither an override nor a stored payment_id exists', async () => {
      repository.getInvoice.mockResolvedValue(mockInvoice({ payment_id: null }));
      repository.updateInvoiceStatus.mockResolvedValue(
        mockInvoice({ status: InvoiceStatus.PAID, payment_id: null }),
      );

      await service.markInvoicePaid(BUSINESS_ID, INVOICE_ID);

      expect(repository.updateInvoiceStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        INVOICE_ID,
        expect.objectContaining({ paymentId: undefined }),
      );
    });

    it('emits an empty paymentId rather than null when nothing settled it', async () => {
      repository.getInvoice.mockResolvedValue(mockInvoice({ payment_id: null }));
      repository.updateInvoiceStatus.mockResolvedValue(
        mockInvoice({ status: InvoiceStatus.PAID, payment_id: null }),
      );

      await service.markInvoicePaid(BUSINESS_ID, INVOICE_ID);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'invoice.paid',
        expect.objectContaining({ paymentId: '' }),
      );
    });

    it('falls back to the override when the update returns no payment_id', async () => {
      repository.getInvoice.mockResolvedValue(mockInvoice({ payment_id: null }));
      repository.updateInvoiceStatus.mockResolvedValue(
        mockInvoice({ status: InvoiceStatus.PAID, payment_id: null }),
      );

      await service.markInvoicePaid(BUSINESS_ID, INVOICE_ID, 'pay_override');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'invoice.paid',
        expect.objectContaining({ paymentId: 'pay_override' }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // renderInvoiceText / toInvoiceDto — null line_items
  // ─────────────────────────────────────────────

  describe('null line_items', () => {
    it('renders an invoice whose line_items column is null', async () => {
      repository.getInvoice.mockResolvedValue(
        mockInvoice({ line_items: null, notes: null }),
      );

      const text = await service.renderInvoiceText(BUSINESS_ID, INVOICE_ID);

      expect(text).toContain('INVOICE INV-2026-000001');
      expect(text).toContain('Subtotal: INR 1000.00');
      expect(text).toContain('Total: INR 1000.00');
      // Zero tax/discount are omitted, and a null notes adds no trailing block.
      expect(text).not.toContain('Tax:');
      expect(text).not.toContain('Discount:');
    });

    it('maps a null line_items column to an empty DTO array', async () => {
      repository.getInvoice.mockResolvedValue(mockInvoice({ line_items: null }));

      const dto = await service.getInvoice(BUSINESS_ID, INVOICE_ID);

      expect(dto.lineItems).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  // payment.success listener
  // ─────────────────────────────────────────────

  describe('handlePaymentSuccess', () => {
    const event = { paymentId: PAYMENT_ID } as PaymentSuccessEvent;

    it('ignores a payment with no linked invoice', async () => {
      repository.findInvoiceByPaymentId.mockResolvedValue(null);

      await service.handlePaymentSuccess(event);

      expect(repository.updateInvoiceStatus).not.toHaveBeenCalled();
    });

    it('is idempotent for an invoice already PAID', async () => {
      repository.findInvoiceByPaymentId.mockResolvedValue(
        mockInvoice({ status: InvoiceStatus.PAID }),
      );

      await service.handlePaymentSuccess(event);

      expect(repository.updateInvoiceStatus).not.toHaveBeenCalled();
    });

    it('logs and swallows an Error so the emitter chain survives', async () => {
      const errorSpy = jest.spyOn(service['logger'], 'error');
      repository.findInvoiceByPaymentId.mockRejectedValue(new Error('db offline'));

      await expect(service.handlePaymentSuccess(event)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('db offline'));
    });

    it('stringifies a non-Error rejection', async () => {
      const errorSpy = jest.spyOn(service['logger'], 'error');
      repository.findInvoiceByPaymentId.mockRejectedValue('connection reset');

      await expect(service.handlePaymentSuccess(event)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    });
  });
});
