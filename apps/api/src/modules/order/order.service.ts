import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { orders } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  OrderStatus,
  PaymentMethod,
  generateId,
  generateCorrelationId,
  currencyToPaise,
} from '@gosumo/shared';
import type {
  OrderCreatedEvent,
  OrderConfirmedEvent,
  OrderCancelledEvent,
  OrderPackedEvent,
  OrderShippedEvent,
  OrderDeliveredEvent,
  OrderReturnedEvent,
  PaymentSuccessEvent,
  PaymentRefundEvent,
} from '@gosumo/shared';
import { OrderRepository } from './order.repository';
import { CouponService } from './coupon.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  CreateOrderDto,
  UpdateOrderStatusDto,
  CancelOrderDto,
  CreateShipmentDto,
  MarkPackedDto,
  ReturnOrderDto,
  ListOrdersQueryDto,
  OrderDto,
  OrderLineItem,
  OrderStatusSummaryDto,
} from './dto';

/**
 * Minimal shape of the `shipping.delivered` event emitted by the shipping
 * module. Declared locally because the shared events package does not yet
 * export a shipping-delivered payload type.
 */
interface ShippingDeliveredEvent {
  businessId: string;
  orderId: string;
  shipmentId?: string;
  deliveredAt?: string;
  correlationId?: string;
}

// ─────────────────────────────────────────────
// Valid state transitions
// ─────────────────────────────────────────────

/**
 * Defines the valid order status transitions.
 * Key = current status, Value = array of statuses that can be transitioned to.
 */
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.DRAFT]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.PACKED, OrderStatus.CANCELLED],
  [OrderStatus.PACKED]: [OrderStatus.SHIPPED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.PARTIALLY_REFUNDED]: [],
  [OrderStatus.RETURNED]: [],
};

// ─────────────────────────────────────────────
// Helper to convert Prisma order to OrderDto
// ─────────────────────────────────────────────

function toOrderDto(order: orders): OrderDto {
  const lineItems = order.line_items as unknown as OrderLineItem[];
  return {
    id: order.id,
    businessId: order.business_id,
    clientId: order.client_id,
    conversationId: order.conversation_id,
    orderNumber: order.order_number,
    status: order.status as OrderStatus,
    lineItems,
    subtotalPaise: currencyToPaise(Number(order.subtotal)),
    discountAmountPaise: currencyToPaise(Number(order.discount_amount)),
    taxAmountPaise: currencyToPaise(Number(order.tax_amount)),
    shippingFeePaise: currencyToPaise(Number(order.shipping_fee)),
    totalPaise: currencyToPaise(Number(order.total)),
    currency: order.currency,
    discountCode: order.discount_code,
    discountType: order.discount_type,
    shippingAddressId: order.shipping_address_id,
    shippingOptionId: order.shipping_option_id,
    customerNote: order.customer_note,
    internalNote: order.internal_note,
    placedAt: order.placed_at.toISOString(),
    confirmedAt: order.confirmed_at?.toISOString() ?? null,
    deliveredAt: order.delivered_at?.toISOString() ?? null,
    cancelledAt: order.cancelled_at?.toISOString() ?? null,
    cancellationReason: order.cancellation_reason,
    returnedAt: order.returned_at?.toISOString() ?? null,
    returnReason: order.return_reason,
    createdAt: order.created_at.toISOString(),
    updatedAt: order.updated_at.toISOString(),
  };
}

/**
 * OrderService — core business logic for the Order module.
 *
 * Manages the full order lifecycle: creation with price snapshots,
 * status transitions via a state machine, cancellation, packing,
 * shipment dispatch, and AI-friendly status queries.
 *
 * Listens to payment events to confirm or refund orders.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly repository: OrderRepository,
    private readonly couponService: CouponService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // Order Creation
  // ─────────────────────────────────────────────

  /**
   * Create a new order.
   *
   * 1. Looks up each item in the catalog and snapshots its price.
   * 2. Calculates subtotal, tax, and total (all in paise).
   * 3. Generates a unique order number (ORD-YYYY-NNNNN).
   * 4. COD orders go straight to CONFIRMED; ONLINE orders start as DRAFT.
   * 5. Emits `order.created`.
   */
  async createOrder(businessId: string, dto: CreateOrderDto): Promise<OrderDto> {
    // Step 1: Snapshot prices from catalog
    const lineItems: OrderLineItem[] = [];
    let subtotalPaise = 0;
    let totalTaxPaise = 0;

    for (const item of dto.items) {
      // Look up the catalog item to snapshot its price
      const catalogItem = await this.prisma.catalog_items.findFirst({
        where: {
          id: item.itemId,
          business_id: businessId,
          is_active: true,
          deleted_at: null,
        },
        include: {
          variants: {
            where: item.variantId
              ? { id: item.variantId, is_active: true, deleted_at: null }
              : undefined,
          },
        },
      });

      if (!catalogItem) {
        throw new BadRequestException(
          `Catalog item not found or inactive: ${item.itemId}`,
        );
      }

      // Determine the effective price (variant overrides item price)
      let unitPriceRupees: number;
      let sku: string | null;
      let name: string;

      if (item.variantId) {
        const variant = catalogItem.variants.find((v) => v.id === item.variantId);
        if (!variant) {
          throw new BadRequestException(
            `Variant not found or inactive: ${item.variantId} for item ${item.itemId}`,
          );
        }
        unitPriceRupees = variant.price
          ? Number(variant.price)
          : Number(catalogItem.price);
        sku = variant.sku ?? catalogItem.sku;
        name = `${catalogItem.name} - ${variant.name}`;
      } else {
        unitPriceRupees = Number(catalogItem.price);
        sku = catalogItem.sku;
        name = catalogItem.name;
      }

      const unitPricePaise = currencyToPaise(unitPriceRupees);
      const totalPricePaise = unitPricePaise * item.quantity;

      // Tax is calculated on the effective price
      const taxRate = Number(catalogItem.tax_rate);
      let taxAmountPaise: number;

      if (catalogItem.tax_inclusive) {
        // Price already includes tax — extract the tax component
        taxAmountPaise = Math.round(
          totalPricePaise - totalPricePaise / (1 + taxRate),
        );
      } else {
        // Tax is additive
        taxAmountPaise = Math.round(totalPricePaise * taxRate);
      }

      lineItems.push({
        itemId: item.itemId,
        variantId: item.variantId ?? null,
        name,
        sku,
        quantity: item.quantity,
        unitPrice: unitPricePaise,
        totalPrice: totalPricePaise,
        taxAmount: taxAmountPaise,
      });

      subtotalPaise += totalPricePaise;
      totalTaxPaise += taxAmountPaise;

      // Reserve stock
      if (catalogItem.track_inventory) {
        if (item.variantId) {
          const variant = catalogItem.variants.find((v) => v.id === item.variantId);
          if (variant && variant.stock_quantity !== null) {
            if (variant.stock_quantity < item.quantity && !catalogItem.allow_backorder) {
              throw new BadRequestException(
                `Insufficient stock for variant ${item.variantId}: available ${variant.stock_quantity}, requested ${item.quantity}`,
              );
            }
            await this.prisma.catalog_variants.update({
              where: { id: item.variantId },
              data: { stock_quantity: { decrement: item.quantity } },
            });
          }
        } else if (catalogItem.stock_quantity !== null) {
          if (catalogItem.stock_quantity < item.quantity && !catalogItem.allow_backorder) {
            throw new BadRequestException(
              `Insufficient stock for item ${item.itemId}: available ${catalogItem.stock_quantity}, requested ${item.quantity}`,
            );
          }
          await this.prisma.catalog_items.update({
            where: { id: item.itemId },
            data: { stock_quantity: { decrement: item.quantity } },
          });
        }
      }
    }

    // Step 2: Apply a coupon/discount if supplied (validated against subtotal)
    let discountAmountPaise = 0;
    let discountCode: string | undefined;
    let discountType: string | undefined;
    let discountValue: number | undefined;
    let appliedCouponId: string | undefined;

    if (dto.discountCode) {
      const discount = await this.couponService.validateAndComputeDiscount(
        businessId,
        dto.discountCode,
        dto.clientId,
        subtotalPaise,
      );
      discountAmountPaise = discount.discountPaise;
      discountCode = discount.code;
      discountType = discount.type;
      discountValue = discount.value;
      appliedCouponId = discount.couponId;
    }

    // Step 3: Resolve the shipping fee from the chosen shipping option (if any)
    const shippingFeePaise = await this.resolveShippingFeePaise(
      businessId,
      dto.shippingOptionId,
      subtotalPaise,
    );

    // Tax is charged on the post-discount value. Recompute the effective tax by
    // scaling the line-item tax down proportionally to the discount applied.
    const effectiveTaxPaise =
      subtotalPaise > 0
        ? Math.round(
            totalTaxPaise * ((subtotalPaise - discountAmountPaise) / subtotalPaise),
          )
        : 0;

    const totalPaise =
      subtotalPaise - discountAmountPaise + effectiveTaxPaise + shippingFeePaise;

    // Step 4: Generate order number
    const orderNumber = await this.repository.getNextOrderNumber(businessId);

    // Step 5: Determine initial status
    const isCod = dto.paymentMethod === PaymentMethod.COD;
    const initialStatus = isCod ? OrderStatus.CONFIRMED : OrderStatus.DRAFT;

    // Step 6: Create the order
    // Convert paise to rupees for Prisma Decimal storage
    const order = await this.repository.createOrder({
      businessId,
      clientId: dto.clientId,
      conversationId: dto.conversationId,
      orderNumber,
      status: initialStatus,
      lineItems: lineItems as unknown as Prisma.InputJsonValue,
      subtotal: subtotalPaise / 100,
      discountAmount: discountAmountPaise / 100,
      taxAmount: effectiveTaxPaise / 100,
      shippingFee: shippingFeePaise / 100,
      total: totalPaise / 100,
      currency: 'INR',
      discountCode,
      discountType,
      discountValue,
      shippingAddressId: dto.shippingAddressId,
      shippingOptionId: dto.shippingOptionId,
      customerNote: dto.notes,
      metadata: { paymentMethod: dto.paymentMethod },
    });

    // Step 7: Record coupon redemption now that the order exists
    if (appliedCouponId) {
      await this.couponService.redeem(appliedCouponId);
    }

    // Step 6: Emit order.created event
    const event: OrderCreatedEvent = {
      type: 'order.created',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      orderId: order.id,
      orderNumber: order.order_number,
      clientId: dto.clientId,
      conversationId: dto.conversationId,
      totalPaise,
      currency: 'INR',
      lineItemCount: lineItems.length,
    };

    this.eventEmitter.emit('order.created', event);

    this.logger.log(
      `Order ${orderNumber} created for client ${dto.clientId} ` +
        `(status: ${initialStatus}, total: ${totalPaise} paise)`,
    );

    return toOrderDto(order);
  }

  // ─────────────────────────────────────────────
  // Order Retrieval
  // ─────────────────────────────────────────────

  /**
   * Get a single order by ID.
   * Throws NotFoundException if not found.
   */
  async getOrder(businessId: string, orderId: string): Promise<OrderDto> {
    const order = await this.repository.findOrderById(businessId, orderId);

    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    return toOrderDto(order);
  }

  /**
   * List orders with optional filters, paginated.
   */
  async listOrders(
    businessId: string,
    query: ListOrdersQueryDto,
  ): Promise<{ data: OrderDto[]; total: number; page: number; limit: number; totalPages: number }> {
    const result = await this.repository.findOrders(businessId, {
      status: query.status,
      clientId: query.clientId,
      search: query.search,
      page: query.page,
      limit: query.limit,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });

    return {
      data: result.data.map(toOrderDto),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  // ─────────────────────────────────────────────
  // Order Status Updates
  // ─────────────────────────────────────────────

  /**
   * Validate and execute a status transition.
   */
  async updateOrderStatus(
    businessId: string,
    orderId: string,
    dto: UpdateOrderStatusDto,
  ): Promise<OrderDto> {
    const order = await this.repository.findOrderById(businessId, orderId);

    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    const currentStatus = order.status as OrderStatus;
    this.validateTransition(currentStatus, dto.status);

    const updated = await this.repository.updateOrderStatus(
      businessId,
      orderId,
      dto.status,
      { internalNote: dto.note },
    );

    this.logger.log(
      `Order ${order.order_number} status changed: ${currentStatus} -> ${dto.status}`,
    );

    return toOrderDto(updated);
  }

  /**
   * Cancel an order.
   * Validates that the order is not already SHIPPED or DELIVERED.
   *
   * Emits `order.cancelled`.
   */
  async cancelOrder(
    businessId: string,
    orderId: string,
    dto: CancelOrderDto,
  ): Promise<OrderDto> {
    const order = await this.repository.findOrderById(businessId, orderId);

    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    const currentStatus = order.status as OrderStatus;

    if (
      currentStatus === OrderStatus.SHIPPED ||
      currentStatus === OrderStatus.DELIVERED
    ) {
      throw new BadRequestException(
        `Cannot cancel order in status ${currentStatus}. ` +
          'Orders that are SHIPPED or DELIVERED cannot be cancelled.',
      );
    }

    if (
      currentStatus === OrderStatus.CANCELLED ||
      currentStatus === OrderStatus.REFUNDED
    ) {
      throw new BadRequestException(
        `Order is already ${currentStatus}.`,
      );
    }

    const now = new Date();

    const updated = await this.repository.updateOrderStatus(
      businessId,
      orderId,
      OrderStatus.CANCELLED,
      {
        cancelledAt: now,
        cancellationReason: dto.reason,
      },
    );

    // Restore stock for cancelled items
    await this.restoreStock(
      businessId,
      order.line_items as unknown as OrderLineItem[],
    );

    // Emit order.cancelled event
    const event: OrderCancelledEvent = {
      type: 'order.cancelled',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      orderId: order.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
      reason: dto.reason,
      cancelledBy: dto.cancelledBy ?? 'BUSINESS',
    };

    this.eventEmitter.emit('order.cancelled', event);

    this.logger.log(
      `Order ${order.order_number} cancelled. Reason: ${dto.reason}`,
    );

    return toOrderDto(updated);
  }

  /**
   * Mark an order as packed.
   * Transitions from PROCESSING to PACKED.
   *
   * Emits `order.packed`.
   */
  async markPacked(
    businessId: string,
    orderId: string,
    dto: MarkPackedDto,
  ): Promise<OrderDto> {
    const order = await this.repository.findOrderById(businessId, orderId);

    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    const currentStatus = order.status as OrderStatus;
    this.validateTransition(currentStatus, OrderStatus.PACKED);

    const updated = await this.repository.updateOrderStatus(
      businessId,
      orderId,
      OrderStatus.PACKED,
      { internalNote: dto.note },
    );

    const event: OrderPackedEvent = {
      type: 'order.packed',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      orderId: order.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
    };

    this.eventEmitter.emit('order.packed', event);

    this.logger.log(`Order ${order.order_number} marked as PACKED`);

    return toOrderDto(updated);
  }

  /**
   * Create a shipment for a packed order.
   * Transitions from PACKED to SHIPPED.
   *
   * Emits `order.shipped`.
   */
  async createShipment(
    businessId: string,
    orderId: string,
    dto: CreateShipmentDto,
  ): Promise<OrderDto> {
    const order = await this.repository.findOrderById(businessId, orderId);

    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    const currentStatus = order.status as OrderStatus;
    this.validateTransition(currentStatus, OrderStatus.SHIPPED);

    // Create the shipment record
    await this.prisma.shipments.create({
      data: {
        business_id: businessId,
        order_id: orderId,
        shipping_address_id: order.shipping_address_id,
        status: 'IN_TRANSIT',
        provider: dto.provider,
        tracking_number: dto.trackingId,
        tracking_url: dto.trackingUrl ?? null,
        carrier: dto.carrier ?? null,
        estimated_delivery_at: dto.estimatedDeliveryAt
          ? new Date(dto.estimatedDeliveryAt)
          : null,
        shipped_at: new Date(),
      },
    });

    // Update order status to SHIPPED
    const updated = await this.repository.updateOrderStatus(
      businessId,
      orderId,
      OrderStatus.SHIPPED,
    );

    const event: OrderShippedEvent = {
      type: 'order.shipped',
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      orderId: order.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
      shipmentId: generateId(),
      trackingNumber: dto.trackingId,
      trackingUrl: dto.trackingUrl,
      carrier: dto.carrier,
      estimatedDeliveryAt: dto.estimatedDeliveryAt,
    };

    this.eventEmitter.emit('order.shipped', event);

    this.logger.log(
      `Order ${order.order_number} shipped. Tracking: ${dto.trackingId} (${dto.provider})`,
    );

    return toOrderDto(updated);
  }

  /**
   * Mark a delivered (or shipped) order as RETURNED.
   * Validates the transition and emits `order.returned`.
   */
  async returnOrder(
    businessId: string,
    orderId: string,
    dto: ReturnOrderDto,
  ): Promise<OrderDto> {
    const order = await this.repository.findOrderById(businessId, orderId);

    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    const currentStatus = order.status as OrderStatus;
    this.validateTransition(currentStatus, OrderStatus.RETURNED);

    const now = new Date();
    const updated = await this.repository.updateOrderStatus(
      businessId,
      orderId,
      OrderStatus.RETURNED,
      { returnedAt: now, returnReason: dto.reason },
    );

    // Restore stock for returned items
    await this.restoreStock(
      businessId,
      order.line_items as unknown as OrderLineItem[],
    );

    const event: OrderReturnedEvent = {
      type: 'order.returned',
      id: generateId(),
      timestamp: now.toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      orderId: order.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
      reason: dto.reason,
      returnedAt: now.toISOString(),
    };

    this.eventEmitter.emit('order.returned', event);

    this.logger.log(
      `Order ${order.order_number} returned. Reason: ${dto.reason}`,
    );

    return toOrderDto(updated);
  }

  // ─────────────────────────────────────────────
  // Client-facing queries (for AI)
  // ─────────────────────────────────────────────

  /**
   * Get an AI-friendly order status summary for a client.
   * If orderId is provided, includes detailed info for that order.
   * Always includes recent orders summary.
   */
  async getOrderStatusForClient(
    businessId: string,
    clientId: string,
    orderId?: string,
  ): Promise<OrderStatusSummaryDto> {
    const [recentOrders, totalOrders] = await Promise.all([
      this.repository.findRecentOrdersForClient(businessId, clientId, 5),
      this.repository.countOrdersForClient(businessId, clientId),
    ]);

    const summary: OrderStatusSummaryDto = {
      clientId,
      recentOrders: recentOrders.map((o) => {
        const items = o.line_items as unknown as OrderLineItem[];
        return {
          orderId: o.id,
          orderNumber: o.order_number,
          status: o.status as OrderStatus,
          totalPaise: currencyToPaise(Number(o.total)),
          itemCount: items.length,
          placedAt: o.placed_at.toISOString(),
        };
      }),
      totalOrders,
    };

    if (orderId) {
      const order = await this.repository.findOrderById(businessId, orderId);
      if (order && order.client_id === clientId) {
        const items = order.line_items as unknown as OrderLineItem[];
        const shipments = (order as Record<string, unknown>)['shipments'] as
          | Array<{
              tracking_number?: string;
              tracking_url?: string;
              estimated_delivery_at?: Date;
            }>
          | undefined;

        const latestShipment = shipments?.[0];

        summary.order = {
          orderId: order.id,
          orderNumber: order.order_number,
          status: order.status as OrderStatus,
          totalPaise: currencyToPaise(Number(order.total)),
          currency: order.currency,
          itemCount: items.length,
          placedAt: order.placed_at.toISOString(),
          trackingNumber: latestShipment?.tracking_number ?? undefined,
          trackingUrl: latestShipment?.tracking_url ?? undefined,
          estimatedDeliveryAt: latestShipment?.estimated_delivery_at
            ?.toISOString() ?? undefined,
        };
      }
    }

    return summary;
  }

  /**
   * Get the N most recent orders for a client.
   */
  async getRecentOrdersForClient(
    businessId: string,
    clientId: string,
    limit: number = 5,
  ): Promise<OrderDto[]> {
    const orders = await this.repository.findRecentOrdersForClient(
      businessId,
      clientId,
      limit,
    );
    return orders.map(toOrderDto);
  }

  // ─────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────

  /**
   * Listen for successful payments.
   * Transitions DRAFT or CONFIRMED orders to CONFIRMED with payment confirmed.
   */
  @OnEvent('payment.success')
  async handlePaymentSuccess(event: PaymentSuccessEvent): Promise<void> {
    if (!event.orderId) {
      return;
    }

    try {
      const order = await this.repository.findOrderById(
        event.businessId,
        event.orderId,
      );

      if (!order) {
        this.logger.warn(
          `Payment success for unknown order ${event.orderId}`,
        );
        return;
      }

      const currentStatus = order.status as OrderStatus;

      if (
        currentStatus !== OrderStatus.DRAFT &&
        currentStatus !== OrderStatus.CONFIRMED
      ) {
        this.logger.debug(
          `Order ${order.order_number} is in status ${currentStatus}, ` +
            'skipping payment confirmation transition',
        );
        return;
      }

      await this.repository.updateOrderStatus(
        event.businessId,
        event.orderId,
        OrderStatus.CONFIRMED,
        { confirmedAt: new Date() },
      );

      const confirmedEvent: OrderConfirmedEvent = {
        type: 'order.confirmed',
        id: generateId(),
        timestamp: new Date().toISOString(),
        businessId: event.businessId,
        correlationId: event.correlationId,
        orderId: order.id,
        orderNumber: order.order_number,
        clientId: order.client_id,
        confirmedAt: new Date().toISOString(),
      };

      this.eventEmitter.emit('order.confirmed', confirmedEvent);

      this.logger.log(
        `Order ${order.order_number} confirmed after payment ${event.paymentId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle payment success for order ${event.orderId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Listen for completed refunds.
   * Transitions CANCELLED orders to REFUNDED.
   */
  @OnEvent('payment.refund.completed')
  async handleRefundCompleted(event: PaymentRefundEvent): Promise<void> {
    if (!event.orderId) {
      return;
    }

    try {
      const order = await this.repository.findOrderById(
        event.businessId,
        event.orderId,
      );

      if (!order) {
        this.logger.warn(
          `Refund completed for unknown order ${event.orderId}`,
        );
        return;
      }

      const currentStatus = order.status as OrderStatus;

      if (currentStatus !== OrderStatus.CANCELLED) {
        this.logger.debug(
          `Order ${order.order_number} is in status ${currentStatus}, ` +
            'skipping refund transition (expected CANCELLED)',
        );
        return;
      }

      await this.repository.updateOrderStatus(
        event.businessId,
        event.orderId,
        OrderStatus.REFUNDED,
      );

      this.logger.log(
        `Order ${order.order_number} marked as REFUNDED after refund ${event.refundId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle refund completion for order ${event.orderId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Listen for shipment delivery confirmations from the shipping module.
   * Transitions SHIPPED orders to DELIVERED and emits `order.delivered`.
   */
  @OnEvent('shipping.delivered')
  async handleShippingDelivered(event: ShippingDeliveredEvent): Promise<void> {
    if (!event.orderId) {
      return;
    }

    try {
      const order = await this.repository.findOrderById(
        event.businessId,
        event.orderId,
      );

      if (!order) {
        this.logger.warn(
          `Shipping delivered for unknown order ${event.orderId}`,
        );
        return;
      }

      const currentStatus = order.status as OrderStatus;
      if (currentStatus !== OrderStatus.SHIPPED) {
        this.logger.debug(
          `Order ${order.order_number} is in status ${currentStatus}, ` +
            'skipping delivered transition (expected SHIPPED)',
        );
        return;
      }

      const deliveredAt = event.deliveredAt
        ? new Date(event.deliveredAt)
        : new Date();

      await this.repository.updateOrderStatus(
        event.businessId,
        event.orderId,
        OrderStatus.DELIVERED,
        { deliveredAt },
      );

      const deliveredEvent: OrderDeliveredEvent = {
        type: 'order.delivered',
        id: generateId(),
        timestamp: new Date().toISOString(),
        businessId: event.businessId,
        correlationId: event.correlationId ?? generateCorrelationId(),
        orderId: order.id,
        orderNumber: order.order_number,
        clientId: order.client_id,
        deliveredAt: deliveredAt.toISOString(),
      };

      this.eventEmitter.emit('order.delivered', deliveredEvent);

      this.logger.log(
        `Order ${order.order_number} marked as DELIVERED`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle shipping delivery for order ${event.orderId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // State machine validation
  // ─────────────────────────────────────────────

  /**
   * Resolve the shipping fee (in paise) for a chosen shipping option.
   * Returns 0 when no option is selected or the option is not found.
   * Honours the option's free-shipping threshold when configured.
   */
  private async resolveShippingFeePaise(
    businessId: string,
    shippingOptionId: string | undefined,
    subtotalPaise: number,
  ): Promise<number> {
    if (!shippingOptionId) {
      return 0;
    }

    const option = await this.prisma.shipping_options.findFirst({
      where: {
        id: shippingOptionId,
        business_id: businessId,
        is_active: true,
        deleted_at: null,
      },
    });

    if (!option) {
      throw new BadRequestException(
        `Shipping option not found or inactive: ${shippingOptionId}`,
      );
    }

    if (option.min_order_value_for_free !== null) {
      const freeThresholdPaise = currencyToPaise(
        Number(option.min_order_value_for_free),
      );
      if (subtotalPaise >= freeThresholdPaise) {
        return 0;
      }
    }

    return currencyToPaise(Number(option.base_fee));
  }

  /**
   * Restore catalog stock for a set of line items (used on cancel/return).
   * Only decrements were applied to inventory-tracked items, so increments are
   * scoped accordingly.
   */
  private async restoreStock(
    businessId: string,
    lineItems: OrderLineItem[],
  ): Promise<void> {
    for (const item of lineItems) {
      if (item.variantId) {
        await this.prisma.catalog_variants.updateMany({
          where: { id: item.variantId, business_id: businessId },
          data: { stock_quantity: { increment: item.quantity } },
        });
      } else {
        await this.prisma.catalog_items.updateMany({
          where: {
            id: item.itemId,
            business_id: businessId,
            track_inventory: true,
          },
          data: { stock_quantity: { increment: item.quantity } },
        });
      }
    }
  }

  /**
   * Validate that a status transition is allowed.
   * Throws BadRequestException if the transition is invalid.
   */
  private validateTransition(
    currentStatus: OrderStatus,
    targetStatus: OrderStatus,
  ): void {
    const allowed = VALID_TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(targetStatus)) {
      throw new BadRequestException(
        `Invalid order status transition: ${currentStatus} -> ${targetStatus}. ` +
          `Allowed transitions from ${currentStatus}: ${allowed?.join(', ') || 'none'}`,
      );
    }
  }
}
