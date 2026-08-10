import { Injectable } from '@nestjs/common';
import {
  Prisma,
  CartStatus as PrismaCartStatus,
  DiscountType as PrismaDiscountType,
} from '@prisma/client';
import type { carts, cart_items } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { DiscountType } from '@gosumo/shared';

export type CartWithItems = carts & { items: cart_items[] };

export interface AddItemData {
  businessId: string;
  cartId: string;
  itemId: string;
  variantId: string | null;
  quantity: number;
  unitPrice: number;
  metadata?: Record<string, unknown>;
}

/**
 * CartRepository — all Prisma queries for shopping carts. Every query is
 * scoped by businessId.
 */
@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveCart(
    businessId: string,
    clientId: string,
  ): Promise<CartWithItems | null> {
    return this.prisma.carts.findFirst({
      where: {
        business_id: businessId,
        client_id: clientId,
        status: PrismaCartStatus.ACTIVE,
        deleted_at: null,
      },
      include: { items: { orderBy: { created_at: 'asc' } } },
    });
  }

  async createCart(businessId: string, clientId: string): Promise<CartWithItems> {
    return this.prisma.carts.create({
      data: {
        business_id: businessId,
        client_id: clientId,
        status: PrismaCartStatus.ACTIVE,
      },
      include: { items: true },
    });
  }

  async findCartById(
    businessId: string,
    cartId: string,
  ): Promise<CartWithItems | null> {
    return this.prisma.carts.findFirst({
      where: { id: cartId, business_id: businessId, deleted_at: null },
      include: { items: { orderBy: { created_at: 'asc' } } },
    });
  }

  /**
   * Find an existing cart line for the same item + variant combination.
   */
  async findItemByProduct(
    businessId: string,
    cartId: string,
    itemId: string,
    variantId: string | null,
  ): Promise<cart_items | null> {
    return this.prisma.cart_items.findFirst({
      where: {
        business_id: businessId,
        cart_id: cartId,
        item_id: itemId,
        variant_id: variantId,
      },
    });
  }

  async createItem(data: AddItemData): Promise<cart_items> {
    return this.prisma.cart_items.create({
      data: {
        business_id: data.businessId,
        cart_id: data.cartId,
        item_id: data.itemId,
        variant_id: data.variantId,
        quantity: data.quantity,
        unit_price: data.unitPrice,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async findItem(
    businessId: string,
    cartId: string,
    cartItemId: string,
  ): Promise<cart_items | null> {
    return this.prisma.cart_items.findFirst({
      where: { id: cartItemId, cart_id: cartId, business_id: businessId },
    });
  }

  async updateItemQuantity(
    businessId: string,
    cartItemId: string,
    quantity: number,
  ): Promise<cart_items> {
    return this.prisma.cart_items.update({
      where: { id: cartItemId, business_id: businessId },
      data: { quantity },
    });
  }

  async removeItem(businessId: string, cartItemId: string): Promise<void> {
    await this.prisma.cart_items.delete({
      where: { id: cartItemId, business_id: businessId },
    });
  }

  async clearItems(businessId: string, cartId: string): Promise<void> {
    await this.prisma.cart_items.deleteMany({
      where: { cart_id: cartId, business_id: businessId },
    });
  }

  async setCoupon(
    businessId: string,
    cartId: string,
    coupon: { couponId: string; code: string; type: DiscountType; value: number },
  ): Promise<void> {
    await this.prisma.carts.update({
      where: { id: cartId, business_id: businessId },
      data: {
        coupon_id: coupon.couponId,
        discount_code: coupon.code,
        discount_type: coupon.type as unknown as PrismaDiscountType,
        discount_value: coupon.value,
      },
    });
  }

  async clearCoupon(businessId: string, cartId: string): Promise<void> {
    await this.prisma.carts.update({
      where: { id: cartId, business_id: businessId },
      data: {
        coupon_id: null,
        discount_code: null,
        discount_type: null,
        discount_value: null,
      },
    });
  }

  /**
   * Mark a cart as converted to an order. Touches updated_at via @updatedAt.
   */
  async markConverted(
    businessId: string,
    cartId: string,
    orderId: string,
  ): Promise<void> {
    await this.prisma.carts.update({
      where: { id: cartId, business_id: businessId },
      data: {
        status: PrismaCartStatus.CONVERTED,
        converted_order_id: orderId,
        converted_at: new Date(),
      },
    });
  }

  /**
   * Touch a cart's updated_at — used after item mutations so the cart's
   * timestamp reflects the latest activity.
   */
  async touch(businessId: string, cartId: string): Promise<void> {
    await this.prisma.carts.update({
      where: { id: cartId, business_id: businessId },
      data: { updated_at: new Date() },
    });
  }
}
