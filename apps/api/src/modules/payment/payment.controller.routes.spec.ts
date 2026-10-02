/**
 * PaymentController — the routes that are pure delegation.
 *
 * Nothing here has logic worth testing in itself, which is exactly why it is
 * worth testing: on a money module the failure mode of a thin controller is
 * that it delegates *slightly wrong*, and every one of those mistakes is
 * silent.
 *
 * Two things are asserted for every route:
 *
 *  - **The tenant comes from the token.** `@TenantId()` is populated by the
 *    interceptor from JWT claims; a route that instead read `dto.businessId`
 *    would let any authenticated caller issue refunds against a stranger's
 *    payments. Each test therefore passes a *different* business id in the
 *    body than in the tenant slot and asserts the tenant slot is what travels.
 *  - **The route reaches the right collaborator.** Invoices live on
 *    `InvoiceService`, payments on `PaymentService`; a cross-wired route would
 *    still compile and still return a plausible object.
 *
 * The two response envelopes get their own assertions, because they are the
 * only place the controller reshapes anything: `GET /payments` wraps the page
 * into `{ data, pagination }`, `GET /payments/links` deliberately does not,
 * and `GET /payments/invoices/:id/text` wraps a bare string into `{ text }`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import type {
  ConfirmCODDto,
  CreateInvoiceDto,
  CreatePaymentLinkDto,
  InitiateRefundDto,
  ListInvoicesQueryDto,
  ListPaymentsQueryDto,
} from './dto';

const BIZ = '00000000-0000-4000-a000-000000000001';
/** The tenant a hostile caller would like to reach. Must never travel. */
const OTHER_BIZ = '00000000-0000-4000-a000-0000000000ff';
const ID = '00000000-0000-4000-a000-000000000002';
const ORDER_ID = '00000000-0000-4000-a000-000000000003';

const PAGE = { data: [{ id: ID }], total: 41, limit: 20, page: 2, totalPages: 3 };

describe('PaymentController (route delegation)', () => {
  let controller: PaymentController;
  // `Record<string, jest.Mock>` would make every lookup `Mock | undefined`
  // under `noUncheckedIndexedAccess`; the mock set is fixed, so name it.
  type Mocks<K extends string> = { [P in K]: jest.Mock };
  let payments: Mocks<
    | 'listPaymentLinks'
    | 'getPaymentStats'
    | 'createPaymentLink'
    | 'getPaymentLink'
    | 'cancelPaymentLink'
    | 'initiateRefund'
    | 'getRefund'
    | 'confirmCODPayment'
    | 'reconcilePayment'
    | 'reconcilePendingPayments'
    | 'getPaymentSummaryForOrder'
  >;
  let invoices: Mocks<
    'createInvoice' | 'listInvoices' | 'getInvoice' | 'renderInvoiceText' | 'issueInvoice'
  >;

  beforeEach(async () => {
    payments = {
      listPaymentLinks: jest.fn().mockResolvedValue(PAGE),
      getPaymentStats: jest.fn().mockResolvedValue({ collectedPaise: 0 }),
      createPaymentLink: jest.fn().mockResolvedValue({ id: ID }),
      getPaymentLink: jest.fn().mockResolvedValue({ id: ID }),
      cancelPaymentLink: jest.fn().mockResolvedValue({ id: ID, status: 'CANCELLED' }),
      initiateRefund: jest.fn().mockResolvedValue({ id: ID }),
      getRefund: jest.fn().mockResolvedValue({ id: ID }),
      confirmCODPayment: jest.fn().mockResolvedValue({ id: ID }),
      reconcilePayment: jest.fn().mockResolvedValue({ changed: false }),
      reconcilePendingPayments: jest.fn().mockResolvedValue({ checked: 0, updated: 0 }),
      getPaymentSummaryForOrder: jest.fn().mockResolvedValue({ orderId: ORDER_ID }),
    };
    invoices = {
      createInvoice: jest.fn().mockResolvedValue({ id: ID }),
      listInvoices: jest.fn().mockResolvedValue(PAGE),
      getInvoice: jest.fn().mockResolvedValue({ id: ID }),
      renderInvoiceText: jest.fn().mockResolvedValue('INV-2026-000001\nTotal ₹1,200'),
      issueInvoice: jest.fn().mockResolvedValue({ id: ID, status: 'ISSUED' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: payments },
        { provide: InvoiceService, useValue: invoices },
      ],
    }).compile();

    controller = module.get(PaymentController);
  });

  // ── Payment links ─────────────────────────────────────────────────────────

  describe('GET /payments', () => {
    it('re-envelopes the page into { data, pagination }', async () => {
      const result = await controller.listPayments(BIZ, {} as ListPaymentsQueryDto);

      expect(result).toEqual({
        data: PAGE.data,
        pagination: { total: 41, limit: 20, page: 2, totalPages: 3 },
      });
      // The count fields move into `pagination` — none may be left at the top
      // level, or a client reading `res.total` gets a stale duplicate.
      expect(result).not.toHaveProperty('total');
    });

    it('forwards the filter query untouched', async () => {
      const query = { status: 'PAID', page: 2, limit: 20 } as unknown as ListPaymentsQueryDto;

      await controller.listPayments(BIZ, query);

      expect(payments.listPaymentLinks).toHaveBeenCalledWith(BIZ, query);
    });
  });

  describe('GET /payments/links', () => {
    it('returns the page as the service shaped it, without the pagination envelope', async () => {
      // Deliberately different from `GET /payments`: this route is the one the
      // dashboard's link table reads, and it expects the flat page.
      await expect(
        controller.listPaymentLinks(BIZ, {} as ListPaymentsQueryDto),
      ).resolves.toBe(PAGE);
    });
  });

  describe('GET /payments/stats', () => {
    it('passes the date window through as given', async () => {
      await controller.getPaymentStats(BIZ, { from: '2026-07-01', to: '2026-07-31' });

      expect(payments.getPaymentStats).toHaveBeenCalledWith(BIZ, {
        from: '2026-07-01',
        to: '2026-07-31',
      });
    });

    it('leaves an omitted window undefined so the service picks its own default', async () => {
      await controller.getPaymentStats(BIZ, {});

      expect(payments.getPaymentStats).toHaveBeenCalledWith(BIZ, {
        from: undefined,
        to: undefined,
      });
    });
  });

  describe('write routes on payment links', () => {
    it('creates a link against the token tenant, not one named in the body', async () => {
      const dto = {
        orderId: ORDER_ID,
        amountPaise: 120000,
        businessId: OTHER_BIZ,
      } as unknown as CreatePaymentLinkDto;

      await controller.createPaymentLink(BIZ, dto);

      expect(payments.createPaymentLink).toHaveBeenCalledWith(BIZ, dto);
      expect(payments.createPaymentLink).not.toHaveBeenCalledWith(OTHER_BIZ, expect.anything());
    });

    it('reads a link within the tenant', async () => {
      await expect(controller.getPaymentLink(BIZ, ID)).resolves.toEqual({ id: ID });
      expect(payments.getPaymentLink).toHaveBeenCalledWith(BIZ, ID);
    });

    it('cancels a link within the tenant', async () => {
      await controller.cancelPaymentLink(BIZ, ID);

      expect(payments.cancelPaymentLink).toHaveBeenCalledWith(BIZ, ID);
    });

    it('lets a service rejection surface rather than reporting success', async () => {
      payments.cancelPaymentLink.mockRejectedValue(new Error('already paid'));

      await expect(controller.cancelPaymentLink(BIZ, ID)).rejects.toThrow('already paid');
    });
  });

  // ── Refunds ───────────────────────────────────────────────────────────────

  describe('refunds', () => {
    it('initiates a refund against the token tenant, not one named in the body', async () => {
      const dto = {
        paymentId: ID,
        amountPaise: 50000,
        businessId: OTHER_BIZ,
      } as unknown as InitiateRefundDto;

      await controller.initiateRefund(BIZ, dto);

      expect(payments.initiateRefund).toHaveBeenCalledWith(BIZ, dto);
    });

    it('reads a refund within the tenant', async () => {
      await controller.getRefund(BIZ, ID);

      expect(payments.getRefund).toHaveBeenCalledWith(BIZ, ID);
    });
  });

  // ── COD ───────────────────────────────────────────────────────────────────

  describe('POST /payments/cod/confirm', () => {
    it('confirms cash collection against the token tenant', async () => {
      const dto = { orderId: ORDER_ID, businessId: OTHER_BIZ } as unknown as ConfirmCODDto;

      await controller.confirmCODPayment(BIZ, dto);

      expect(payments.confirmCODPayment).toHaveBeenCalledWith(BIZ, dto);
    });
  });

  // ── Reconciliation ────────────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('reconciles one payment within the tenant', async () => {
      await controller.reconcilePayment(BIZ, ID);

      expect(payments.reconcilePayment).toHaveBeenCalledWith(BIZ, ID);
    });

    it('reconciles the tenant’s pending payments and nobody else’s', async () => {
      await controller.reconcilePending(BIZ);

      expect(payments.reconcilePendingPayments).toHaveBeenCalledWith(BIZ);
      expect(payments.reconcilePendingPayments).toHaveBeenCalledTimes(1);
    });
  });

  // ── Invoices ──────────────────────────────────────────────────────────────

  describe('invoices', () => {
    it('routes invoice creation to InvoiceService, not PaymentService', async () => {
      const dto = { orderId: ORDER_ID, businessId: OTHER_BIZ } as unknown as CreateInvoiceDto;

      await controller.createInvoice(BIZ, dto);

      expect(invoices.createInvoice).toHaveBeenCalledWith(BIZ, dto);
      expect(payments.createPaymentLink).not.toHaveBeenCalled();
    });

    it('forwards the invoice list query', async () => {
      const query = { status: 'ISSUED' } as unknown as ListInvoicesQueryDto;

      await expect(controller.listInvoices(BIZ, query)).resolves.toBe(PAGE);
      expect(invoices.listInvoices).toHaveBeenCalledWith(BIZ, query);
    });

    it('reads one invoice within the tenant', async () => {
      await controller.getInvoice(BIZ, ID);

      expect(invoices.getInvoice).toHaveBeenCalledWith(BIZ, ID);
    });

    it('wraps the rendered invoice in an object rather than returning a bare string', async () => {
      // A bare string body would be sent as `text/plain`; the dashboard and
      // the WhatsApp sender both read `res.text`.
      await expect(controller.getInvoiceText(BIZ, ID)).resolves.toEqual({
        text: 'INV-2026-000001\nTotal ₹1,200',
      });
      expect(invoices.renderInvoiceText).toHaveBeenCalledWith(BIZ, ID);
    });

    it('issues a draft invoice within the tenant', async () => {
      await controller.issueInvoice(BIZ, ID);

      expect(invoices.issueInvoice).toHaveBeenCalledWith(BIZ, ID);
    });
  });

  // ── Order summary ─────────────────────────────────────────────────────────

  describe('GET /payments/orders/:orderId/summary', () => {
    it('summarises an order within the tenant', async () => {
      await controller.getPaymentSummary(BIZ, ORDER_ID);

      expect(payments.getPaymentSummaryForOrder).toHaveBeenCalledWith(BIZ, ORDER_ID);
    });

    it('does not translate a missing order into an empty summary', async () => {
      payments.getPaymentSummaryForOrder.mockRejectedValue(new Error('order not found'));

      await expect(controller.getPaymentSummary(BIZ, ORDER_ID)).rejects.toThrow('order not found');
    });
  });
});
