import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { cart_items } from '@prisma/client';
import { CartStatus, DiscountType, currencyToPaise } from '@gosumo/shared';

/** Prisma Decimal/null → finite number (NaN and null both become 0). */
function dec(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
import { PrismaService } from '../../common/services/prisma.service';
import { CartRepository, CartWithItems } from './cart.repository';
import { CouponService } from './coupon.service';
import { OrderService } from './order.service';
import {
  AddCartItemDto,
  UpdateCartItemDto,
  ApplyCartCouponDto,
  CheckoutCartDto,
  CartDto,
  CartItemDto,
} from './dto/cart.dto';
import { OrderDto } from './dto';

interface ResolvedProduct {
  unitPricePaise: number;
  name: string;
  sku: string | null;
}

/**
 * CartService — manages the shopping cart staging area before checkout.
 *
 * Cart items hold a display-time price snapshot; the authoritative price and
 * stock checks happen at checkout when the cart is converted into an order via
 * the OrderService.
 */
@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly repository: CartRepository,
    private readonly prisma: PrismaService,
    private readonly couponService: CouponService,
    private readonly orderService: OrderService,
  ) {}

  // ─────────────────────────────────────────────
  // Cart retrieval
  // ─────────────────────────────────────────────

  /**
   * Return the client's active cart, creating an empty one if none exists.
   */
  async getOrCreateCart(businessId: string, clientId: string): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    return this.toCartDto(cart);
  }

  private async getOrCreateActiveCart(
    businessId: string,
    clientId: string,
  ): Promise<CartWithItems> {
    const existing = await this.repository.findActiveCart(businessId, clientId);
    if (existing) {
      return existing;
    }
    return this.repository.createCart(businessId, clientId);
  }

  // ─────────────────────────────────────────────
  // Item mutations
  // ─────────────────────────────────────────────

  /**
   * Add an item to the cart. If the same item/variant is already present, its
   * quantity is incremented.
   */
  async addItem(
    businessId: string,
    clientId: string,
    dto: AddCartItemDto,
  ): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    const variantId = dto.variantId ?? null;
    const product = await this.resolveProduct(businessId, dto.itemId, variantId);

    const existingLine = await this.repository.findItemByProduct(
      businessId,
      cart.id,
      dto.itemId,
      variantId,
    );

    if (existingLine) {
      await this.repository.updateItemQuantity(
        businessId,
        existingLine.id,
        existingLine.quantity + dto.quantity,
      );
    } else {
      await this.repository.createItem({
        businessId,
        cartId: cart.id,
        itemId: dto.itemId,
        variantId,
        quantity: dto.quantity,
        unitPrice: product.unitPricePaise / 100,
        metadata: { name: product.name, sku: product.sku },
      });
    }

    await this.repository.touch(businessId, cart.id);
    return this.getReloadedCart(businessId, cart.id);
  }

  async updateItem(
    businessId: string,
    clientId: string,
    cartItemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    const line = await this.repository.findItem(businessId, cart.id, cartItemId);
    if (!line) {
      throw new NotFoundException(`Cart item not found: ${cartItemId}`);
    }
    await this.repository.updateItemQuantity(businessId, cartItemId, dto.quantity);
    await this.repository.touch(businessId, cart.id);
    return this.getReloadedCart(businessId, cart.id);
  }

  async removeItem(
    businessId: string,
    clientId: string,
    cartItemId: string,
  ): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    const line = await this.repository.findItem(businessId, cart.id, cartItemId);
    if (!line) {
      throw new NotFoundException(`Cart item not found: ${cartItemId}`);
    }
    await this.repository.removeItem(businessId, cartItemId);
    await this.repository.touch(businessId, cart.id);
    return this.getReloadedCart(businessId, cart.id);
  }

  async clearCart(businessId: string, clientId: string): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    await this.repository.clearItems(businessId, cart.id);
    await this.repository.clearCoupon(businessId, cart.id);
    await this.repository.touch(businessId, cart.id);
    return this.getReloadedCart(businessId, cart.id);
  }

  // ─────────────────────────────────────────────
  // Coupon
  // ─────────────────────────────────────────────

  /**
   * Validate and attach a coupon to the cart. The discount is re-validated
   * authoritatively at checkout.
   */
  async applyCoupon(
    businessId: string,
    clientId: string,
    dto: ApplyCartCouponDto,
  ): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    const subtotalPaise = this.computeSubtotalPaise(cart.items);

    if (subtotalPaise <= 0) {
      throw new BadRequestException('Cannot apply a coupon to an empty cart');
    }

    // Throws BadRequestException if the coupon is not applicable.
    const discount = await this.couponService.validateAndComputeDiscount(
      businessId,
      dto.code,
      clientId,
      subtotalPaise,
    );

    await this.repository.setCoupon(businessId, cart.id, {
      couponId: discount.couponId,
      code: discount.code,
      type: discount.type,
      value: discount.value,
    });

    return this.getReloadedCart(businessId, cart.id);
  }

  async removeCoupon(businessId: string, clientId: string): Promise<CartDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);
    await this.repository.clearCoupon(businessId, cart.id);
    return this.getReloadedCart(businessId, cart.id);
  }

  // ─────────────────────────────────────────────
  // Checkout
  // ─────────────────────────────────────────────

  /**
   * Convert the active cart into an order via the OrderService, then mark the
   * cart as CONVERTED. The OrderService performs the authoritative price
   * snapshot, stock reservation, and coupon re-validation.
   */
  async checkout(
    businessId: string,
    clientId: string,
    dto: CheckoutCartDto,
  ): Promise<OrderDto> {
    const cart = await this.getOrCreateActiveCart(businessId, clientId);

    if (cart.items.length === 0) {
      throw new BadRequestException('Cannot checkout an empty cart');
    }

    const order = await this.orderService.createOrder(businessId, {
      clientId,
      items: cart.items.map((i) => ({
        itemId: i.item_id,
        variantId: i.variant_id ?? undefined,
        quantity: i.quantity,
      })),
      paymentMethod: dto.paymentMethod,
      shippingAddressId: dto.shippingAddressId,
      shippingOptionId: dto.shippingOptionId,
      discountCode: cart.discount_code ?? undefined,
      notes: dto.notes,
      conversationId: dto.conversationId,
    });

    await this.repository.markConverted(businessId, cart.id, order.id);

    this.logger.log(
      `Cart ${cart.id} checked out → order ${order.orderNumber} for client ${clientId}`,
    );

    return order;
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private async getReloadedCart(
    businessId: string,
    cartId: string,
  ): Promise<CartDto> {
    const cart = await this.repository.findCartById(businessId, cartId);
    if (!cart) {
      throw new NotFoundException(`Cart not found: ${cartId}`);
    }
    return this.toCartDto(cart);
  }

  /**
   * Look up a catalog item/variant and return its current price snapshot.
   */
  private async resolveProduct(
    businessId: string,
    itemId: string,
    variantId: string | null,
  ): Promise<ResolvedProduct> {
    const catalogItem = await this.prisma.catalog_items.findFirst({
      where: {
        id: itemId,
        business_id: businessId,
        is_active: true,
        deleted_at: null,
      },
      include: {
        variants: variantId
          ? { where: { id: variantId, is_active: true, deleted_at: null } }
          : false,
      },
    });

    if (!catalogItem) {
      throw new BadRequestException(`Catalog item not found or inactive: ${itemId}`);
    }

    if (variantId) {
      const variant = catalogItem.variants.find((v) => v.id === variantId);
      if (!variant) {
        throw new BadRequestException(
          `Variant not found or inactive: ${variantId} for item ${itemId}`,
        );
      }
      const priceRupees = variant.price
        ? dec(variant.price)
        : dec(catalogItem.price);
      return {
        unitPricePaise: currencyToPaise(priceRupees),
        name: `${catalogItem.name} - ${variant.name}`,
        sku: variant.sku ?? catalogItem.sku,
      };
    }

    return {
      unitPricePaise: currencyToPaise(dec(catalogItem.price)),
      name: catalogItem.name,
      sku: catalogItem.sku,
    };
  }

  private computeSubtotalPaise(items: cart_items[]): number {
    return items.reduce(
      (sum, i) => sum + currencyToPaise(dec(i.unit_price)) * i.quantity,
      0,
    );
  }

  /**
   * Compute the display discount in paise from the stored coupon type/value.
   * The authoritative discount (with caps/limits) is recomputed at checkout.
   */
  private computeDiscountPaise(
    type: DiscountType | null,
    value: number | null,
    subtotalPaise: number,
  ): number {
    if (!type || value === null) {
      return 0;
    }
    let discount: number;
    if (type === DiscountType.PERCENT) {
      discount = Math.round((subtotalPaise * value) / 100);
    } else {
      discount = currencyToPaise(value);
    }
    return Math.min(discount, subtotalPaise);
  }

  private toCartDto(cart: CartWithItems): CartDto {
    const items: CartItemDto[] = cart.items.map((i) => {
      const meta = (i.metadata ?? {}) as { name?: string; sku?: string | null };
      const unitPricePaise = currencyToPaise(dec(i.unit_price));
      return {
        id: i.id,
        itemId: i.item_id,
        variantId: i.variant_id,
        name: meta.name ?? 'Item',
        sku: meta.sku ?? null,
        quantity: i.quantity,
        unitPricePaise,
        lineTotalPaise: unitPricePaise * i.quantity,
      };
    });

    const subtotalPaise = items.reduce((s, i) => s + i.lineTotalPaise, 0);
    const discountPaise = this.computeDiscountPaise(
      cart.discount_type as unknown as DiscountType | null,
      cart.discount_value === null ? null : dec(cart.discount_value),
      subtotalPaise,
    );

    return {
      id: cart.id,
      businessId: cart.business_id,
      clientId: cart.client_id,
      status: cart.status as unknown as CartStatus,
      items,
      subtotalPaise,
      discountCode: cart.discount_code,
      discountPaise,
      totalPaise: subtotalPaise - discountPaise,
      itemCount: items.reduce((s, i) => s + i.quantity, 0),
      createdAt: cart.created_at.toISOString(),
      updatedAt: cart.updated_at.toISOString(),
    };
  }
}
