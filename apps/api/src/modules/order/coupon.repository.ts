import { Injectable, Logger } from '@nestjs/common';
import { Prisma, DiscountType as PrismaDiscountType } from '@prisma/client';
import type { coupons } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { DiscountType } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreateCouponData {
  businessId: string;
  code: string;
  description?: string;
  type: DiscountType;
  value: number;
  minOrderValue?: number;
  maxDiscount?: number;
  usageLimit?: number;
  perClientLimit?: number;
  validFrom?: Date;
  validUntil?: Date;
}

export interface UpdateCouponData {
  description?: string;
  type?: DiscountType;
  value?: number;
  minOrderValue?: number | null;
  maxDiscount?: number | null;
  usageLimit?: number | null;
  perClientLimit?: number | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
  isActive?: boolean;
}

export interface CouponListFilters {
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedCoupons {
  data: coupons[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * CouponRepository — all Prisma queries for coupons.
 *
 * Every query is scoped by businessId.
 */
@Injectable()
export class CouponRepository {
  private readonly logger = new Logger(CouponRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateCouponData): Promise<coupons> {
    return this.prisma.coupons.create({
      data: {
        business_id: data.businessId,
        code: data.code,
        description: data.description ?? null,
        type: data.type as unknown as PrismaDiscountType,
        value: data.value,
        min_order_value: data.minOrderValue ?? null,
        max_discount: data.maxDiscount ?? null,
        usage_limit: data.usageLimit ?? null,
        per_client_limit: data.perClientLimit ?? null,
        valid_from: data.validFrom ?? null,
        valid_until: data.validUntil ?? null,
      },
    });
  }

  /**
   * Find an active (non-deleted) coupon by its code, case-insensitively.
   */
  async findByCode(businessId: string, code: string): Promise<coupons | null> {
    return this.prisma.coupons.findFirst({
      where: {
        business_id: businessId,
        code: { equals: code, mode: 'insensitive' },
        deleted_at: null,
      },
    });
  }

  async findById(businessId: string, couponId: string): Promise<coupons | null> {
    return this.prisma.coupons.findFirst({
      where: {
        id: couponId,
        business_id: businessId,
        deleted_at: null,
      },
    });
  }

  async list(
    businessId: string,
    filters: CouponListFilters,
  ): Promise<PaginatedCoupons> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.couponsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.isActive !== undefined) {
      where.is_active = filters.isActive;
    }

    const [data, total] = await Promise.all([
      this.prisma.coupons.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.coupons.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async update(
    businessId: string,
    couponId: string,
    data: UpdateCouponData,
  ): Promise<coupons> {
    const updateData: Prisma.couponsUpdateInput = {};
    if (data.description !== undefined) updateData.description = data.description;
    if (data.type !== undefined) {
      updateData.type = data.type as unknown as PrismaDiscountType;
    }
    if (data.value !== undefined) updateData.value = data.value;
    if (data.minOrderValue !== undefined) {
      updateData.min_order_value = data.minOrderValue;
    }
    if (data.maxDiscount !== undefined) updateData.max_discount = data.maxDiscount;
    if (data.usageLimit !== undefined) updateData.usage_limit = data.usageLimit;
    if (data.perClientLimit !== undefined) {
      updateData.per_client_limit = data.perClientLimit;
    }
    if (data.validFrom !== undefined) updateData.valid_from = data.validFrom;
    if (data.validUntil !== undefined) updateData.valid_until = data.validUntil;
    if (data.isActive !== undefined) updateData.is_active = data.isActive;

    return this.prisma.coupons.update({
      where: { id: couponId },
      data: updateData,
    });
  }

  /**
   * Soft-delete a coupon by setting deleted_at and deactivating it.
   */
  async softDelete(businessId: string, couponId: string): Promise<coupons> {
    return this.prisma.coupons.update({
      where: { id: couponId },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  /**
   * Atomically increment the global redemption counter for a coupon.
   */
  async incrementUsage(couponId: string): Promise<void> {
    await this.prisma.coupons.update({
      where: { id: couponId },
      data: { usage_count: { increment: 1 } },
    });
  }

  /**
   * Count how many non-cancelled orders a client has placed using a discount code.
   * Used to enforce per-client redemption limits.
   */
  async countClientRedemptions(
    businessId: string,
    clientId: string,
    code: string,
  ): Promise<number> {
    return this.prisma.orders.count({
      where: {
        business_id: businessId,
        client_id: clientId,
        discount_code: { equals: code, mode: 'insensitive' },
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
        deleted_at: null,
      },
    });
  }
}
