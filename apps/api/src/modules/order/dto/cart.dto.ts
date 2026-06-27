import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, CartStatus } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

export class AddCartItemDto {
  @ApiProperty({ description: 'UUID of the catalog item' })
  @IsUUID()
  itemId!: string;

  @ApiPropertyOptional({ description: 'UUID of the catalog variant' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiProperty({ description: 'Quantity to add', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class UpdateCartItemDto {
  @ApiProperty({ description: 'New quantity for the line', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class ApplyCartCouponDto {
  @ApiProperty({ description: 'Coupon code to apply to the cart' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;
}

export class CheckoutCartDto {
  @ApiProperty({ enum: PaymentMethod, description: 'Payment method' })
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

  @ApiPropertyOptional({ description: 'Customer notes for the order' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'UUID of the originating conversation' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

export interface CartItemDto {
  id: string;
  itemId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  /** Unit price in paise */
  unitPricePaise: number;
  /** quantity * unitPrice in paise */
  lineTotalPaise: number;
}

export interface CartDto {
  id: string;
  businessId: string;
  clientId: string;
  status: CartStatus;
  items: CartItemDto[];
  /** Sum of line totals in paise */
  subtotalPaise: number;
  discountCode: string | null;
  /** Computed discount in paise (re-validated authoritatively at checkout) */
  discountPaise: number;
  /** subtotal - discount in paise */
  totalPaise: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}
