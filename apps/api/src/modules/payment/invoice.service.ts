import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { invoices } from '@prisma/client';
import {
  InvoiceStatus,
  generateId,
  generateCorrelationId,
  currencyToPaise,
} from '@gosumo/shared';
import type {
  InvoiceCreatedEvent,
  InvoiceIssuedEvent,
  InvoicePaidEvent,
  PaymentSuccessEvent,
} from '@gosumo/shared';
import { PaymentRepository, InvoiceLineItemData } from './payment.repository';
import { createWithSequentialNumber } from '../../common/utils/sequential-number.util';
import {
  CreateInvoiceDto,
  InvoiceDto,
  InvoiceLineItemDto,
  ListInvoicesQueryDto,
} from './dto';
import { PaginatedInvoices } from './payment.repository';

/**
 * InvoiceService — generates and tracks customer invoices.
 *
 * Owns:
 *  - Invoice generation (line items, tax/discount, totals)
 *  - Per-business, per-year sequential invoice numbering (INV-YYYY-NNNNNN)
 *  - Invoice lifecycle: DRAFT → ISSUED → PAID
 *  - Plain-text rendering for sharing over WhatsApp/SMS
 *
 * Emits: invoice.created, invoice.issued, invoice.paid
 * Listens: payment.success → marks the linked invoice PAID
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly repository: PaymentRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Generate a DRAFT invoice. Computes line totals, subtotal, and the grand
   * total (subtotal + tax − discount, floored at zero).
   *
   * Emits `invoice.created`.
   */
  async createInvoice(
    businessId: string,
    dto: CreateInvoiceDto,
  ): Promise<InvoiceDto> {
    const currency = dto.currency ?? 'INR';

    // Compute line totals (all in minor units / paise).
    const lineItems: InvoiceLineItemData[] = dto.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitAmountMinor: item.unitAmountPaise,
      amountMinor: item.quantity * item.unitAmountPaise,
    }));

    const subtotalPaise = lineItems.reduce((sum, li) => sum + li.amountMinor, 0);
    const taxPaise = dto.taxAmountPaise ?? 0;
    const discountPaise = dto.discountAmountPaise ?? 0;
    const totalPaise = Math.max(0, subtotalPaise + taxPaise - discountPaise);

    // The number is derived from what is already stored, so two invoices
    // raised at the same instant derive the same one and the unique constraint
    // rejects the second. Re-derive and retry rather than failing the invoice.
    const invoice = await createWithSequentialNumber(
      () => this.generateInvoiceNumber(businessId),
      (invoiceNumber) =>
        this.repository.createInvoice({
          businessId,
          orderId: dto.orderId,
          clientId: dto.clientId,
          paymentId: dto.paymentId,
          invoiceNumber,
          currency,
          // Repository stores in major units (rupees) as Decimal(14,2).
          subtotal: subtotalPaise / 100,
          taxAmount: taxPaise / 100,
          discountAmount: discountPaise / 100,
          total: totalPaise / 100,
          lineItems,
          notes: dto.notes,
          dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
        }),
      'invoice_number',
    );

    const event: InvoiceCreatedEvent = {
      type: 'invoice.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      invoiceId: invoice.id,
      // Read back from the stored row, not from a locally generated value: a
      // retried create issues a different number than the first attempt did.
      invoiceNumber: invoice.invoice_number,
      orderId: dto.orderId,
      clientId: dto.clientId,
      paymentId: dto.paymentId,
      totalPaise,
      currency,
    };
    this.eventEmitter.emit('invoice.created', event);

    this.logger.log(
      `Created invoice ${invoice.invoice_number} (${invoice.id}) for client ${dto.clientId} — ${totalPaise} paise`,
    );

    return this.toInvoiceDto(invoice);
  }

  /**
   * Get a single invoice by ID.
   */
  async getInvoice(businessId: string, invoiceId: string): Promise<InvoiceDto> {
    const invoice = await this.repository.getInvoice(businessId, invoiceId);
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    return this.toInvoiceDto(invoice);
  }

  /**
   * List invoices for a business with optional filters.
   */
  async listInvoices(
    businessId: string,
    query: ListInvoicesQueryDto,
  ): Promise<{ data: InvoiceDto[]; total: number; page: number; limit: number; totalPages: number }> {
    const result: PaginatedInvoices = await this.repository.listInvoices(
      businessId,
      {
        status: query.status,
        orderId: query.orderId,
        clientId: query.clientId,
        page: query.page,
        limit: query.limit,
      },
    );

    return {
      data: result.data.map((inv) => this.toInvoiceDto(inv)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Transition an invoice from DRAFT to ISSUED.
   *
   * Emits `invoice.issued`.
   */
  async issueInvoice(businessId: string, invoiceId: string): Promise<InvoiceDto> {
    const invoice = await this.repository.getInvoice(businessId, invoiceId);
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT invoices can be issued; this invoice is ${invoice.status}`,
      );
    }

    const updated = await this.repository.updateInvoiceStatus(businessId, invoiceId, {
      status: InvoiceStatus.ISSUED,
      issuedAt: new Date(),
    });

    const event: InvoiceIssuedEvent = {
      type: 'invoice.issued',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      invoiceId: updated.id,
      invoiceNumber: updated.invoice_number,
      clientId: updated.client_id,
      totalPaise: currencyToPaise(Number(updated.total)),
      currency: updated.currency,
    };
    this.eventEmitter.emit('invoice.issued', event);

    this.logger.log(`Issued invoice ${updated.invoice_number} (${updated.id})`);

    return this.toInvoiceDto(updated);
  }

  /**
   * Mark an invoice as PAID and link the settling payment.
   *
   * Emits `invoice.paid`.
   */
  async markInvoicePaid(
    businessId: string,
    invoiceId: string,
    paymentId?: string,
  ): Promise<InvoiceDto> {
    const invoice = await this.repository.getInvoice(businessId, invoiceId);
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    if (invoice.status === InvoiceStatus.CANCELLED || invoice.status === InvoiceStatus.VOID) {
      throw new BadRequestException(
        `Cannot mark a ${invoice.status} invoice as paid.`,
      );
    }

    const updated = await this.repository.updateInvoiceStatus(businessId, invoiceId, {
      status: InvoiceStatus.PAID,
      paidAt: new Date(),
      paymentId: paymentId ?? invoice.payment_id ?? undefined,
    });

    const event: InvoicePaidEvent = {
      type: 'invoice.paid',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      invoiceId: updated.id,
      invoiceNumber: updated.invoice_number,
      paymentId: updated.payment_id ?? paymentId ?? '',
      clientId: updated.client_id,
      totalPaise: currencyToPaise(Number(updated.total)),
      currency: updated.currency,
    };
    this.eventEmitter.emit('invoice.paid', event);

    this.logger.log(`Marked invoice ${updated.invoice_number} (${updated.id}) PAID`);

    return this.toInvoiceDto(updated);
  }

  /**
   * Render a plain-text invoice suitable for sharing over WhatsApp/SMS.
   */
  async renderInvoiceText(businessId: string, invoiceId: string): Promise<string> {
    const invoice = await this.repository.getInvoice(businessId, invoiceId);
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    const lineItems = (invoice.line_items as unknown as InvoiceLineItemData[]) ?? [];
    const fmt = (paise: number): string =>
      `${invoice.currency} ${(paise / 100).toFixed(2)}`;

    const lines: string[] = [];
    lines.push(`INVOICE ${invoice.invoice_number}`);
    lines.push(`Status: ${invoice.status}`);
    lines.push('');
    for (const item of lineItems) {
      lines.push(
        `${item.description} × ${item.quantity} — ${fmt(item.amountMinor)}`,
      );
    }
    lines.push('');
    lines.push(`Subtotal: ${fmt(currencyToPaise(Number(invoice.subtotal)))}`);
    if (Number(invoice.tax_amount) > 0) {
      lines.push(`Tax: ${fmt(currencyToPaise(Number(invoice.tax_amount)))}`);
    }
    if (Number(invoice.discount_amount) > 0) {
      lines.push(`Discount: -${fmt(currencyToPaise(Number(invoice.discount_amount)))}`);
    }
    lines.push(`Total: ${fmt(currencyToPaise(Number(invoice.total)))}`);
    if (invoice.notes) {
      lines.push('');
      lines.push(invoice.notes);
    }

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────
  // Event listeners
  // ─────────────────────────────────────────────

  /**
   * When a payment succeeds, mark its linked invoice (if any) as PAID.
   */
  @OnEvent('payment.success')
  async handlePaymentSuccess(event: PaymentSuccessEvent): Promise<void> {
    try {
      const invoice = await this.repository.findInvoiceByPaymentId(event.businessId, event.paymentId);
      if (!invoice || invoice.status === InvoiceStatus.PAID) {
        return;
      }
      await this.markInvoicePaid(invoice.business_id, invoice.id, event.paymentId);
    } catch (error) {
      this.logger.error(
        `Failed to mark invoice paid for payment ${event.paymentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Generate the next per-business, per-year sequential invoice number.
   * Format: INV-YYYY-NNNNNN (e.g. INV-2026-000042).
   */
  private async generateInvoiceNumber(businessId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const highest = await this.repository.findHighestInvoiceSequenceForYear(businessId, year);
    const sequence = String(highest + 1).padStart(6, '0');
    return `INV-${year}-${sequence}`;
  }

  private toInvoiceDto(invoice: invoices): InvoiceDto {
    const rawLineItems =
      (invoice.line_items as unknown as InvoiceLineItemData[]) ?? [];
    const lineItems: InvoiceLineItemDto[] = rawLineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitAmountPaise: li.unitAmountMinor,
      amountPaise: li.amountMinor,
    }));

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoice_number,
      orderId: invoice.order_id,
      clientId: invoice.client_id,
      paymentId: invoice.payment_id,
      status: invoice.status,
      currency: invoice.currency,
      subtotalPaise: currencyToPaise(Number(invoice.subtotal)),
      taxPaise: currencyToPaise(Number(invoice.tax_amount)),
      discountPaise: currencyToPaise(Number(invoice.discount_amount)),
      totalPaise: currencyToPaise(Number(invoice.total)),
      lineItems,
      notes: invoice.notes,
      issuedAt: invoice.issued_at?.toISOString() ?? null,
      dueAt: invoice.due_at?.toISOString() ?? null,
      paidAt: invoice.paid_at?.toISOString() ?? null,
      createdAt: invoice.created_at.toISOString(),
    };
  }
}
