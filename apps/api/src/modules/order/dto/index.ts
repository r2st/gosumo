import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsArray,
  IsDateString,
  ValidateNested,
  Min,
  Max,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus, PaymentMethod } from '@gosumo/shared';

export * from './coupon.dto';
export * from './cart.dto';
export * from './address.dto';

// ─────────────────────────────────────────────
// Nested DTOs
// ─────────────────────────────────────────────

/**
 * A single item in a create-order request.
 */
export class CreateOrderItemDto {
  @ApiProperty({ description: 'UUID of the catalog item' })
  @IsUUID()
  itemId!: string;

  @ApiPropertyOptional({ description: 'UUID of the catalog variant (optional)' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiProperty({ description: 'Quantity to order', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

/**
 * DTO for creating a new order.
 */
export class CreateOrderDto {
  @ApiProperty({ description: 'UUID of the client placing the order' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'Line items to include in the order', type: [CreateOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @ApiProperty({ enum: ['ONLINE', 'COD', 'UPI'], description: 'Payment method' })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({ description: 'UUID of the shipping address' })
  @IsOptional()
  @IsUUID()
  shippingAddressId?: string;

  @ApiPropertyOptional({ description: 'UUID of the chosen shipping option' })
  @IsOptional()
  @IsUUID()
  shippingOptionId?: string;

  @ApiPropertyOptional({ description: 'Discount/coupon code to apply' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  discountCode?: string;

  @ApiPropertyOptional({ description: 'Customer notes for the order' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'UUID of the conversation that triggered this order' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

/**
 * DTO for returning a delivered order.
 */
export class ReturnOrderDto {
  @ApiProperty({ description: 'Reason for the return' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/**
 * DTO for updating an order's status.
 */
export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus, description: 'New order status' })
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @ApiPropertyOptional({ description: 'Internal note about the status change' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * DTO for cancelling an order.
 */
export class CancelOrderDto {
  @ApiProperty({ description: 'Reason for cancellation' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({ description: '"CLIENT" | "BUSINESS" | "SYSTEM"' })
  @IsOptional()
  @IsString()
  cancelledBy?: string;
}

/**
 * DTO for creating a shipment against a packed order.
 */
export class CreateShipmentDto {
  @ApiProperty({ description: 'Tracking ID from the shipping provider' })
  @IsString()
  @IsNotEmpty()
  trackingId!: string;

  @ApiProperty({ description: 'Shipping provider name (e.g. SHIPROCKET, DELHIVERY, MANUAL)' })
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @ApiPropertyOptional({ description: 'Carrier name' })
  @IsOptional()
  @IsString()
  carrier?: string;

  @ApiPropertyOptional({ description: 'Tracking URL' })
  @IsOptional()
  @IsString()
  trackingUrl?: string;

  @ApiPropertyOptional({ description: 'Estimated delivery date (ISO-8601)' })
  @IsOptional()
  @IsDateString()
  estimatedDeliveryAt?: string;
}

/**
 * DTO for marking an order as packed.
 */
export class MarkPackedDto {
  @ApiPropertyOptional({ description: 'Internal note about packing' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

// ─────────────────────────────────────────────
// Query DTOs
// ─────────────────────────────────────────────

/**
 * Query parameters for listing orders with filters and pagination.
 */
export class ListOrdersQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus, description: 'Filter by order status' })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Filter by client UUID' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Search by order number (partial, case-insensitive)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  search?: string;

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

  @ApiPropertyOptional({ description: 'Filter orders placed on or after this date (ISO-8601)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Filter orders placed on or before this date (ISO-8601)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

/**
 * Line item snapshot stored in the order JSONB column.
 */
export interface OrderLineItem {
  itemId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  /** Unit price in paise */
  unitPrice: number;
  /** Total price for this line (unitPrice * quantity) in paise */
  totalPrice: number;
  /** Tax amount for this line in paise */
  taxAmount: number;
}

/**
 * Full order response DTO.
 */
export interface OrderDto {
  id: string;
  businessId: string;
  clientId: string;
  conversationId: string | null;
  orderNumber: string;
  status: OrderStatus;
  lineItems: OrderLineItem[];
  /** Subtotal in paise */
  subtotalPaise: number;
  /** Discount amount in paise */
  discountAmountPaise: number;
  /** Tax amount in paise */
  taxAmountPaise: number;
  /** Shipping fee in paise */
  shippingFeePaise: number;
  /** Total in paise */
  totalPaise: number;
  currency: string;
  discountCode: string | null;
  discountType: string | null;
  shippingAddressId: string | null;
  shippingOptionId: string | null;
  customerNote: string | null;
  internalNote: string | null;
  placedAt: string;
  confirmedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * AI-friendly order status summary.
 */
export interface OrderStatusSummaryDto {
  clientId: string;
  /** If a specific orderId was requested, details for that order */
  order?: {
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
    totalPaise: number;
    currency: string;
    itemCount: number;
    placedAt: string;
    trackingNumber?: string;
    trackingUrl?: string;
    estimatedDeliveryAt?: string;
  };
  /** Recent orders summary */
  recentOrders: Array<{
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
    totalPaise: number;
    itemCount: number;
    placedAt: string;
  }>;
  totalOrders: number;
}
