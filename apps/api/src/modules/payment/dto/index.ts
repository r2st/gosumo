import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsEmail,
  IsArray,
  IsDateString,
  ValidateNested,
  ArrayMinSize,
  Length,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus, PaymentGateway, InvoiceStatus } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

/**
 * DTO for creating a Razorpay payment link.
 */
export class CreatePaymentLinkDto {
  @ApiPropertyOptional({ description: 'UUID of the order (optional for standalone payment links)' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiProperty({ description: 'UUID of the client to collect payment from' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'Amount in paise (integer)', example: 100050 })
  @IsInt()
  @Min(100) // minimum 1 rupee = 100 paise
  amountPaise!: number;

  @ApiPropertyOptional({ description: 'Payment description shown to customer', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Payment link expiry in minutes (default: 1440 = 24h)', example: 1440 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(43200) // max 30 days
  expiryMinutes?: number;

  @ApiPropertyOptional({
    description:
      'ISO 4217 currency code. Defaults to INR. Non-INR currencies route to Stripe.',
    example: 'INR',
  })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    enum: PaymentGateway,
    description:
      'Force a specific gateway. If omitted, INR → Razorpay and other currencies → Stripe.',
  })
  @IsOptional()
  @IsEnum(PaymentGateway)
  gateway?: PaymentGateway;

  @ApiPropertyOptional({ description: "Customer email (used by Stripe Checkout)" })
  @IsOptional()
  @IsEmail()
  customerEmail?: string;
}

/**
 * Response DTO for a payment link.
 */
export class PaymentLinkDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() orderId?: string | null;
  @ApiProperty() clientId!: string;
  @ApiProperty() amountPaise!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PaymentGateway }) gateway!: string;
  @ApiProperty({ enum: ['PENDING', 'INITIATED', 'SUCCESS', 'FAILED', 'EXPIRED'] })
  status!: string;
  @ApiPropertyOptional() paymentLinkUrl?: string | null;
  @ApiPropertyOptional() paymentLinkId?: string | null;
  @ApiPropertyOptional() expiresAt?: string | null;
  @ApiProperty() createdAt!: string;
}

/**
 * Full transaction/payment record response.
 */
export class TransactionDto {
  @ApiProperty() id!: string;
  @ApiProperty() businessId!: string;
  @ApiPropertyOptional() orderId?: string | null;
  @ApiProperty() clientId!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() method?: string | null;
  @ApiProperty() gateway!: string;
  @ApiProperty() amountPaise!: number;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional() gatewayOrderId?: string | null;
  @ApiPropertyOptional() gatewayPaymentId?: string | null;
  @ApiPropertyOptional() paymentLinkUrl?: string | null;
  @ApiPropertyOptional() paymentLinkId?: string | null;
  @ApiPropertyOptional() expiresAt?: string | null;
  @ApiPropertyOptional() initiatedAt?: string | null;
  @ApiPropertyOptional() capturedAt?: string | null;
  @ApiPropertyOptional() failedAt?: string | null;
  @ApiPropertyOptional() failureReason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/**
 * DTO for initiating a refund against a payment.
 */
export class InitiateRefundDto {
  @ApiProperty({ description: 'UUID of the payment/transaction to refund' })
  @IsUUID()
  transactionId!: string;

  @ApiProperty({ description: 'Refund amount in paise (integer)', example: 50000 })
  @IsInt()
  @Min(100)
  amountPaise!: number;

  @ApiProperty({ description: 'Reason for the refund', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/**
 * Response DTO for a refund.
 */
export class RefundDto {
  @ApiProperty() id!: string;
  @ApiProperty() paymentId!: string;
  @ApiPropertyOptional() orderId?: string | null;
  @ApiProperty() amountPaise!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() reason?: string | null;
  @ApiProperty() requiresApproval!: boolean;
  @ApiPropertyOptional() gatewayRefundId?: string | null;
  @ApiProperty() createdAt!: string;
}

/**
 * DTO for confirming a Cash-On-Delivery payment.
 */
export class ConfirmCODDto {
  @ApiProperty({ description: 'UUID of the order' })
  @IsUUID()
  orderId!: string;

  @ApiProperty({ description: 'UUID of the client' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'Amount collected in paise (integer)', example: 199900 })
  @IsInt()
  @Min(100)
  amountPaise!: number;

  @ApiProperty({ description: 'Name or ID of the person who collected', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  collectedBy!: string;
}

/**
 * Aggregated payment summary for an order.
 */
export class PaymentSummaryDto {
  @ApiProperty({ description: 'Total paid in paise' }) paidPaise!: number;
  @ApiProperty({ description: 'Total pending in paise' }) pendingPaise!: number;
  @ApiProperty({ description: 'Total refunded in paise' }) refundedPaise!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() orderId!: string;
}

// ─────────────────────────────────────────────
// Query DTOs
// ─────────────────────────────────────────────

/**
 * Query parameters for listing payments with optional filters and pagination.
 */
export class ListPaymentsQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus, description: 'Filter by payment status' })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ description: 'Filter by order UUID' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ description: 'Filter by client UUID' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// Invoice DTOs
// ─────────────────────────────────────────────

/**
 * A single line item on an invoice. Amounts are in minor units (paise).
 */
export class InvoiceLineItemInputDto {
  @ApiProperty({ description: 'Line item description', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @ApiProperty({ description: 'Quantity', example: 2 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ description: 'Unit price in paise (integer)', example: 49900 })
  @IsInt()
  @Min(0)
  unitAmountPaise!: number;
}

/**
 * DTO for generating an invoice.
 */
export class CreateInvoiceDto {
  @ApiPropertyOptional({ description: 'UUID of the related order' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiProperty({ description: 'UUID of the client being billed' })
  @IsUUID()
  clientId!: string;

  @ApiPropertyOptional({ description: 'UUID of the payment this invoice is for' })
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @ApiProperty({ type: [InvoiceLineItemInputDto], description: 'Invoice line items' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemInputDto)
  lineItems!: InvoiceLineItemInputDto[];

  @ApiPropertyOptional({ description: 'Tax amount in paise (integer)', example: 9000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  taxAmountPaise?: number;

  @ApiPropertyOptional({ description: 'Discount amount in paise (integer)', example: 5000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountAmountPaise?: number;

  @ApiPropertyOptional({ description: 'ISO 4217 currency code', example: 'INR' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({ description: 'Notes shown on the invoice', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dueAt?: string;
}

/**
 * Response DTO for a line item.
 */
export class InvoiceLineItemDto {
  @ApiProperty() description!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitAmountPaise!: number;
  @ApiProperty() amountPaise!: number;
}

/**
 * Response DTO for an invoice.
 */
export class InvoiceDto {
  @ApiProperty() id!: string;
  @ApiProperty() invoiceNumber!: string;
  @ApiPropertyOptional() orderId?: string | null;
  @ApiProperty() clientId!: string;
  @ApiPropertyOptional() paymentId?: string | null;
  @ApiProperty({ enum: InvoiceStatus }) status!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() subtotalPaise!: number;
  @ApiProperty() taxPaise!: number;
  @ApiProperty() discountPaise!: number;
  @ApiProperty() totalPaise!: number;
  @ApiProperty({ type: [InvoiceLineItemDto] }) lineItems!: InvoiceLineItemDto[];
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() issuedAt?: string | null;
  @ApiPropertyOptional() dueAt?: string | null;
  @ApiPropertyOptional() paidAt?: string | null;
  @ApiProperty() createdAt!: string;
}

/**
 * Query parameters for listing invoices.
 */
export class ListInvoicesQueryDto {
  @ApiPropertyOptional({ enum: InvoiceStatus, description: 'Filter by invoice status' })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional({ description: 'Filter by order UUID' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ description: 'Filter by client UUID' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// Reconciliation DTOs
// ─────────────────────────────────────────────

/**
 * Result of reconciling a single payment against its gateway.
 */
export class ReconcileResultDto {
  @ApiProperty() paymentId!: string;
  @ApiProperty({ description: 'Status before reconciliation' }) previousStatus!: string;
  @ApiProperty({ description: 'Status after reconciliation' }) currentStatus!: string;
  @ApiProperty({ description: 'Whether the status changed' }) changed!: boolean;
  @ApiPropertyOptional({ description: 'Gateway-reported status' }) gatewayStatus?: string;
}

/**
 * Summary of a batch reconciliation run.
 */
export class ReconciliationSummaryDto {
  @ApiProperty({ description: 'Number of payments checked' }) checked!: number;
  @ApiProperty({ description: 'Number of payments updated' }) updated!: number;
  @ApiProperty({ type: [ReconcileResultDto] }) results!: ReconcileResultDto[];
}
