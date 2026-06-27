import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { Request } from 'express';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreatePaymentLinkDto,
  InitiateRefundDto,
  ConfirmCODDto,
  ListPaymentsQueryDto,
  CreateInvoiceDto,
  ListInvoicesQueryDto,
} from './dto';

/**
 * PaymentController — REST endpoints for payment management.
 *
 * All routes are protected by JwtAuthGuard except the Razorpay webhook.
 * The @TenantId() decorator extracts businessId from the JWT-populated
 * request context.
 *
 * Routes:
 *   POST   /payments/links                  — create payment link
 *   GET    /payments/links                  — list payment links
 *   GET    /payments/links/:id              — get payment link
 *   DELETE /payments/links/:id              — cancel payment link
 *   POST   /payments/refunds                — initiate refund
 *   GET    /payments/refunds/:id            — get refund
 *   POST   /payments/cod/confirm            — confirm COD payment
 *   POST   /webhooks/razorpay               — Razorpay webhook (public, raw body)
 *   GET    /payments/orders/:orderId/summary — payment summary for order
 */
@ApiTags('payments')
@Controller()
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly invoiceService: InvoiceService,
  ) {}

  // ─────────────────────────────────────────────
  // Payment Links
  // ─────────────────────────────────────────────

  @Get('payments')
  @ApiOperation({ summary: 'List all payments' })
  @ApiResponse({ status: 200, description: 'Paginated list of payments' })
  async listPayments(
    @TenantId() tenantId: string,
    @Query() query: ListPaymentsQueryDto,
  ) {
    const result = await this.paymentService.listPaymentLinks(tenantId, query);
    const { data, ...rest } = result as any;
    return { data: data ?? [], pagination: { total: rest.total ?? 0, limit: rest.limit ?? 100, page: rest.page ?? 1, totalPages: rest.totalPages ?? 0 } };
  }

  @Post('payments/links')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a payment link via Razorpay' })
  @ApiResponse({ status: 201, description: 'Payment link created' })
  async createPaymentLink(
    @TenantId() tenantId: string,
    @Body() dto: CreatePaymentLinkDto,
  ) {
    return this.paymentService.createPaymentLink(tenantId, dto);
  }

  @Get('payments/links')
  @ApiOperation({ summary: 'List payment links with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of payment links' })
  async listPaymentLinks(
    @TenantId() tenantId: string,
    @Query() query: ListPaymentsQueryDto,
  ) {
    return this.paymentService.listPaymentLinks(tenantId, query);
  }

  @Get('payments/links/:id')
  @ApiOperation({ summary: 'Get a payment link by ID' })
  @ApiParam({ name: 'id', description: 'Payment UUID' })
  @ApiResponse({ status: 200, description: 'Payment link details' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async getPaymentLink(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.paymentService.getPaymentLink(tenantId, id);
  }

  @Delete('payments/links/:id')
  @ApiOperation({ summary: 'Cancel a pending payment link' })
  @ApiParam({ name: 'id', description: 'Payment UUID' })
  @ApiResponse({ status: 200, description: 'Payment link cancelled' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 400, description: 'Payment cannot be cancelled' })
  async cancelPaymentLink(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.paymentService.cancelPaymentLink(tenantId, id);
  }

  // ─────────────────────────────────────────────
  // Refunds
  // ─────────────────────────────────────────────

  @Post('payments/refunds')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Initiate a refund against a payment' })
  @ApiResponse({ status: 201, description: 'Refund initiated' })
  @ApiResponse({ status: 400, description: 'Refund validation failed' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async initiateRefund(
    @TenantId() tenantId: string,
    @Body() dto: InitiateRefundDto,
  ) {
    return this.paymentService.initiateRefund(tenantId, dto);
  }

  @Get('payments/refunds')
  @ApiOperation({ summary: 'List refunds with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of refunds' })
  async listRefunds(
    @TenantId() tenantId: string,
    @Query('paymentId') paymentId?: string,
    @Query('orderId') orderId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.paymentService.listRefunds(tenantId, {
      paymentId,
      orderId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('payments/refunds/:id')
  @ApiOperation({ summary: 'Get a refund by ID' })
  @ApiParam({ name: 'id', description: 'Refund UUID' })
  @ApiResponse({ status: 200, description: 'Refund details' })
  @ApiResponse({ status: 404, description: 'Refund not found' })
  async getRefund(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.paymentService.getRefund(tenantId, id);
  }

  // ─────────────────────────────────────────────
  // COD
  // ─────────────────────────────────────────────

  @Post('payments/cod/confirm')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Confirm a Cash-On-Delivery payment' })
  @ApiResponse({ status: 201, description: 'COD payment confirmed' })
  async confirmCODPayment(
    @TenantId() tenantId: string,
    @Body() dto: ConfirmCODDto,
  ) {
    return this.paymentService.confirmCODPayment(tenantId, dto);
  }

  // ─────────────────────────────────────────────
  // Razorpay Webhook
  // ─────────────────────────────────────────────

  @Public()
  @Post('webhooks/razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay webhook endpoint (public)' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleRazorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));

    await this.paymentService.handleRazorpayWebhook(rawBody, signature ?? '');

    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // Stripe Webhook
  // ─────────────────────────────────────────────

  @Public()
  @Post('webhooks/stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook endpoint (public)' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));

    await this.paymentService.handleStripeWebhook(rawBody, signature ?? '');

    return { received: true };
  }

  // ─────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────

  @Post('payments/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile a single payment against its gateway' })
  @ApiParam({ name: 'id', description: 'Payment UUID' })
  @ApiResponse({ status: 200, description: 'Reconciliation result' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async reconcilePayment(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.paymentService.reconcilePayment(tenantId, id);
  }

  @Post('payments/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile all pending payments for the business' })
  @ApiResponse({ status: 200, description: 'Reconciliation summary' })
  async reconcilePending(@TenantId() tenantId: string) {
    return this.paymentService.reconcilePendingPayments(tenantId);
  }

  // ─────────────────────────────────────────────
  // Invoices
  // ─────────────────────────────────────────────

  @Post('payments/invoices')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate an invoice' })
  @ApiResponse({ status: 201, description: 'Invoice created' })
  async createInvoice(
    @TenantId() tenantId: string,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.invoiceService.createInvoice(tenantId, dto);
  }

  @Get('payments/invoices')
  @ApiOperation({ summary: 'List invoices with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of invoices' })
  async listInvoices(
    @TenantId() tenantId: string,
    @Query() query: ListInvoicesQueryDto,
  ) {
    return this.invoiceService.listInvoices(tenantId, query);
  }

  @Get('payments/invoices/:id')
  @ApiOperation({ summary: 'Get an invoice by ID' })
  @ApiParam({ name: 'id', description: 'Invoice UUID' })
  @ApiResponse({ status: 200, description: 'Invoice details' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  async getInvoice(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.invoiceService.getInvoice(tenantId, id);
  }

  @Get('payments/invoices/:id/text')
  @ApiOperation({ summary: 'Render a plain-text invoice for sharing' })
  @ApiParam({ name: 'id', description: 'Invoice UUID' })
  @ApiResponse({ status: 200, description: 'Plain-text invoice' })
  async getInvoiceText(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    const text = await this.invoiceService.renderInvoiceText(tenantId, id);
    return { text };
  }

  @Post('payments/invoices/:id/issue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a draft invoice' })
  @ApiParam({ name: 'id', description: 'Invoice UUID' })
  @ApiResponse({ status: 200, description: 'Invoice issued' })
  @ApiResponse({ status: 400, description: 'Invoice not in DRAFT state' })
  async issueInvoice(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.invoiceService.issueInvoice(tenantId, id);
  }

  // ─────────────────────────────────────────────
  // Payment Summary
  // ─────────────────────────────────────────────

  @Get('payments/orders/:orderId/summary')
  @ApiOperation({ summary: 'Get payment summary for an order' })
  @ApiParam({ name: 'orderId', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Payment summary' })
  async getPaymentSummary(
    @TenantId() tenantId: string,
    @Param('orderId', UuidValidationPipe) orderId: string,
  ) {
    return this.paymentService.getPaymentSummaryForOrder(tenantId, orderId);
  }
}
