import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  IsNumber,
  IsBoolean,
  IsUUID,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_NUMBER } from '../../../common/validators/pagination.constants';
import { DiscountType } from '@gosumo/shared';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

/**
 * DTO for creating a coupon.
 */
export class CreateCouponDto {
  @ApiProperty({ description: 'Coupon code (alphanumeric, dashes allowed)', example: 'DIWALI20' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'code may only contain letters, numbers, dashes and underscores',
  })
  code!: string;

  @ApiPropertyOptional({ description: 'Human-readable description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: DiscountType, description: 'PERCENT or FIXED' })
  @IsEnum(DiscountType)
  type!: DiscountType;

  @ApiProperty({
    description: 'Discount value — percent (0-100) for PERCENT, rupees for FIXED',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  value!: number;

  @ApiPropertyOptional({ description: 'Minimum order subtotal in rupees required to apply' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderValue?: number;

  @ApiPropertyOptional({ description: 'Maximum discount amount in rupees (caps PERCENT coupons)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscount?: number;

  @ApiPropertyOptional({ description: 'Max total redemptions across all customers' })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @ApiPropertyOptional({ description: 'Max redemptions per individual client' })
  @IsOptional()
  @IsInt()
  @Min(1)
  perClientLimit?: number;

  @ApiPropertyOptional({ description: 'Coupon valid from (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  validFrom?: string;

  @ApiPropertyOptional({ description: 'Coupon valid until (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  validUntil?: string;
}

/**
 * DTO for updating a coupon. All fields optional.
 */
export class UpdateCouponDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: DiscountType })
  @IsOptional()
  @IsEnum(DiscountType)
  type?: DiscountType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  perClientLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsCalendarDateString()
  validFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsCalendarDateString()
  validUntil?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Query params for previewing/validating a coupon against an order subtotal.
 */
export class ValidateCouponQueryDto {
  @ApiProperty({ description: 'Coupon code to validate' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Client UUID the coupon would apply to' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'Order subtotal in paise', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  subtotalPaise!: number;
}

export class ListCouponsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by active state' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// Response DTOs / shared shapes
// ─────────────────────────────────────────────

export interface CouponDto {
  id: string;
  businessId: string;
  code: string;
  description: string | null;
  type: DiscountType;
  value: number;
  minOrderValuePaise: number | null;
  maxDiscountPaise: number | null;
  usageLimit: number | null;
  perClientLimit: number | null;
  usageCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The computed result of validating a coupon against a subtotal.
 */
export interface DiscountResult {
  couponId: string;
  code: string;
  type: DiscountType;
  /** Raw coupon value (percent number or rupees) */
  value: number;
  /** Computed discount in paise (already capped) */
  discountPaise: number;
}
