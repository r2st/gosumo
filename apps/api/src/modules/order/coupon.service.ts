import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import type { coupons } from '@prisma/client';
import { DiscountType, currencyToPaise } from '@gosumo/shared';
import { CouponRepository } from './coupon.repository';
import {
  CreateCouponDto,
  UpdateCouponDto,
  CouponDto,
  DiscountResult,
} from './dto/coupon.dto';

/** Prisma Decimal/null → finite number (NaN and null both become 0). */
function dec(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toCouponDto(c: coupons): CouponDto {
  return {
    id: c.id,
    businessId: c.business_id,
    code: c.code,
    description: c.description,
    type: c.type as unknown as DiscountType,
    value: dec(c.value),
    minOrderValuePaise:
      c.min_order_value === null ? null : currencyToPaise(dec(c.min_order_value)),
    maxDiscountPaise:
      c.max_discount === null ? null : currencyToPaise(dec(c.max_discount)),
    usageLimit: c.usage_limit,
    perClientLimit: c.per_client_limit,
    usageCount: c.usage_count,
    validFrom: c.valid_from?.toISOString() ?? null,
    validUntil: c.valid_until?.toISOString() ?? null,
    isActive: c.is_active,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };
}

/**
 * CouponService — coupon CRUD plus the validation/redemption logic used by
 * the order and cart features.
 *
 * Discount math is done entirely in paise to avoid floating-point drift.
 */
@Injectable()
export class CouponService {
  private readonly logger = new Logger(CouponService.name);

  constructor(private readonly repository: CouponRepository) {}

  // ─────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────

  async createCoupon(businessId: string, dto: CreateCouponDto): Promise<CouponDto> {
    if (dto.type === DiscountType.PERCENT && dto.value > 100) {
      throw new BadRequestException('PERCENT coupon value cannot exceed 100');
    }

    const normalizedCode = dto.code.trim().toUpperCase();
    const existing = await this.repository.findByCode(businessId, normalizedCode);
    if (existing) {
      throw new ConflictException(`Coupon code already exists: ${normalizedCode}`);
    }

    if (dto.validFrom && dto.validUntil) {
      if (new Date(dto.validFrom) >= new Date(dto.validUntil)) {
        throw new BadRequestException('validFrom must be before validUntil');
      }
    }

    const coupon = await this.repository.create({
      businessId,
      code: normalizedCode,
      description: dto.description,
      type: dto.type,
      value: dto.value,
      minOrderValue: dto.minOrderValue,
      maxDiscount: dto.maxDiscount,
      usageLimit: dto.usageLimit,
      perClientLimit: dto.perClientLimit,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
      validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
    });

    this.logger.log(`Coupon ${normalizedCode} created for business ${businessId}`);
    return toCouponDto(coupon);
  }

  async listCoupons(
    businessId: string,
    filters: { isActive?: boolean; page?: number; limit?: number },
  ): Promise<{ data: CouponDto[]; total: number; page: number; limit: number; totalPages: number }> {
    const result = await this.repository.list(businessId, filters);
    return {
      data: result.data.map(toCouponDto),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async getCoupon(businessId: string, couponId: string): Promise<CouponDto> {
    const coupon = await this.repository.findById(businessId, couponId);
    if (!coupon) {
      throw new NotFoundException(`Coupon not found: ${couponId}`);
    }
    return toCouponDto(coupon);
  }

  async updateCoupon(
    businessId: string,
    couponId: string,
    dto: UpdateCouponDto,
  ): Promise<CouponDto> {
    const coupon = await this.repository.findById(businessId, couponId);
    if (!coupon) {
      throw new NotFoundException(`Coupon not found: ${couponId}`);
    }

    const effectiveType = dto.type ?? (coupon.type as unknown as DiscountType);
    if (
      effectiveType === DiscountType.PERCENT &&
      dto.value !== undefined &&
      dto.value > 100
    ) {
      throw new BadRequestException('PERCENT coupon value cannot exceed 100');
    }

    const updated = await this.repository.update(businessId, couponId, {
      description: dto.description,
      type: dto.type,
      value: dto.value,
      minOrderValue: dto.minOrderValue,
      maxDiscount: dto.maxDiscount,
      usageLimit: dto.usageLimit,
      perClientLimit: dto.perClientLimit,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
      validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      isActive: dto.isActive,
    });

    return toCouponDto(updated);
  }

  async deactivateCoupon(businessId: string, couponId: string): Promise<CouponDto> {
    const coupon = await this.repository.findById(businessId, couponId);
    if (!coupon) {
      throw new NotFoundException(`Coupon not found: ${couponId}`);
    }
    const deleted = await this.repository.softDelete(businessId, couponId);
    this.logger.log(`Coupon ${coupon.code} deactivated for business ${businessId}`);
    return toCouponDto(deleted);
  }

  // ─────────────────────────────────────────────
  // Validation + redemption (used by order/cart)
  // ─────────────────────────────────────────────

  /**
   * Validate a coupon code for a client against an order subtotal and compute
   * the discount. Throws BadRequestException with a specific reason if the
   * coupon cannot be applied. All money is in paise.
   */
  async validateAndComputeDiscount(
    businessId: string,
    code: string,
    clientId: string,
    subtotalPaise: number,
    now: Date = new Date(),
  ): Promise<DiscountResult> {
    const coupon = await this.repository.findByCode(businessId, code.trim());

    if (!coupon || !coupon.is_active) {
      throw new BadRequestException(`Invalid or inactive coupon: ${code}`);
    }

    if (coupon.valid_from && now < coupon.valid_from) {
      throw new BadRequestException(`Coupon ${coupon.code} is not active yet`);
    }
    if (coupon.valid_until && now > coupon.valid_until) {
      throw new BadRequestException(`Coupon ${coupon.code} has expired`);
    }

    if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
      throw new BadRequestException(
        `Coupon ${coupon.code} has reached its usage limit`,
      );
    }

    if (coupon.per_client_limit !== null) {
      const redemptions = await this.repository.countClientRedemptions(
        businessId,
        clientId,
        coupon.code,
      );
      if (redemptions >= coupon.per_client_limit) {
        throw new BadRequestException(
          `Coupon ${coupon.code} has already been used the maximum number of times`,
        );
      }
    }

    if (coupon.min_order_value !== null) {
      const minPaise = currencyToPaise(dec(coupon.min_order_value));
      if (subtotalPaise < minPaise) {
        throw new BadRequestException(
          `Coupon ${coupon.code} requires a minimum order of ` +
            `INR ${dec(coupon.min_order_value)}`,
        );
      }
    }

    const type = coupon.type as unknown as DiscountType;
    let discountPaise: number;

    if (type === DiscountType.PERCENT) {
      discountPaise = Math.round((subtotalPaise * dec(coupon.value)) / 100);
      if (coupon.max_discount !== null) {
        const capPaise = currencyToPaise(dec(coupon.max_discount));
        discountPaise = Math.min(discountPaise, capPaise);
      }
    } else {
      discountPaise = currencyToPaise(dec(coupon.value));
    }

    // A discount can never exceed the subtotal.
    discountPaise = Math.min(discountPaise, subtotalPaise);

    return {
      couponId: coupon.id,
      code: coupon.code,
      type,
      value: dec(coupon.value),
      discountPaise,
    };
  }

  /**
   * Record a successful redemption — increments the global usage counter.
   * Per-client tracking is derived from orders carrying the discount code.
   */
  async redeem(businessId: string, couponId: string): Promise<void> {
    await this.repository.incrementUsage(businessId, couponId);
  }
}
