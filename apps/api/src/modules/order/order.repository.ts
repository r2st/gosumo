import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';
import { OrderStatus, ResourceNotFoundError } from '@gosumo/shared';
import { Prisma, OrderStatus as PrismaOrderStatus } from '@prisma/client';
import type { orders } from '@prisma/client';

// ─────────────────────────────────────────────
// Data interfaces
// ─────────────────────────────────────────────

export interface CreateOrderData {
  businessId: string;
  clientId: string;
  conversationId?: string;
  orderNumber: string;
  status: OrderStatus;
  lineItems: Prisma.InputJsonValue;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  shippingFee: number;
  total: number;
  currency: string;
  discountCode?: string;
  discountType?: string;
  discountValue?: number;
  shippingAddressId?: string;
  shippingOptionId?: string;
  customerNote?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderListFilters {
  status?: OrderStatus;
  clientId?: string;
  search?: string;
  page?: number;
  limit?: number;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface PaginatedOrders {
  data: orders[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * OrderRepository — all Prisma queries for the Order module.
 *
 * Every query includes businessId scoping.
 */
@Injectable()
export class OrderRepository {
  private readonly logger = new Logger(OrderRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new order with line items snapshot.
   */
  async createOrder(data: CreateOrderData): Promise<orders> {
    return this.prisma.orders.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        conversation_id: data.conversationId ?? null,
        order_number: data.orderNumber,
        status: data.status as unknown as PrismaOrderStatus,
        line_items: data.lineItems,
        subtotal: data.subtotal,
        discount_amount: data.discountAmount,
        tax_amount: data.taxAmount,
        shipping_fee: data.shippingFee,
        total: data.total,
        currency: data.currency,
        discount_code: data.discountCode ?? null,
        discount_type: data.discountType ?? null,
        discount_value: data.discountValue ?? null,
        shipping_address_id: data.shippingAddressId ?? null,
        shipping_option_id: data.shippingOptionId ?? null,
        customer_note: data.customerNote ?? null,
        confirmed_at: data.status === OrderStatus.CONFIRMED ? new Date() : null,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Find an order by ID within a business scope.
   */
  async findOrderById(
    businessId: string,
    orderId: string,
  ): Promise<orders | null> {
    return this.prisma.orders.findFirst({
      where: {
        id: orderId,
        business_id: businessId,
        deleted_at: null,
      },
      include: {
        client: true,
        shipping_address: true,
        shipments: true,
        payments: true,
      },
    });
  }

  /**
   * List orders for a business with optional filters, paginated.
   * Ordered by placed_at DESC.
   */
  async findOrders(
    businessId: string,
    filters: OrderListFilters,
  ): Promise<PaginatedOrders> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ordersWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };

    if (filters.status) {
      where.status = filters.status as unknown as PrismaOrderStatus;
    }
    if (filters.clientId) {
      where.client_id = filters.clientId;
    }
    if (filters.search) {
      where.order_number = {
        // Escaped so `%`/`_` are searched for, not executed as LIKE wildcards.
        contains: escapeLikeTerm(filters.search),
        mode: 'insensitive',
      };
    }
    if (filters.dateFrom || filters.dateTo) {
      where.placed_at = {};
      if (filters.dateFrom) {
        where.placed_at.gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        where.placed_at.lte = filters.dateTo;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.orders.findMany({
        where,
        include: {
          client: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: { placed_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.orders.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update order status and optional fields, guarded by expected current status.
   *
   * Uses `updateMany` with `expectedStatus` in the WHERE clause so the state-
   * machine check and the write are one atomic statement (CAS). Returns `null`
   * when the row was not in `expectedStatus` — the caller lost the race.
   */
  async updateOrderStatus(
    businessId: string,
    orderId: string,
    expectedStatus: OrderStatus,
    status: OrderStatus,
    extra?: {
      confirmedAt?: Date;
      deliveredAt?: Date;
      cancelledAt?: Date;
      cancellationReason?: string;
      returnedAt?: Date;
      returnReason?: string;
      internalNote?: string;
    },
  ): Promise<orders | null> {
    const data: Prisma.ordersUpdateManyMutationInput = {
      status: status as unknown as PrismaOrderStatus,
    };

    if (extra?.confirmedAt) {
      data.confirmed_at = extra.confirmedAt;
    }
    if (extra?.deliveredAt) {
      data.delivered_at = extra.deliveredAt;
    }
    if (extra?.cancelledAt) {
      data.cancelled_at = extra.cancelledAt;
    }
    if (extra?.cancellationReason) {
      data.cancellation_reason = extra.cancellationReason;
    }
    if (extra?.returnedAt) {
      data.returned_at = extra.returnedAt;
    }
    if (extra?.returnReason) {
      data.return_reason = extra.returnReason;
    }
    if (extra?.internalNote) {
      data.internal_note = extra.internalNote;
    }

    const result = await this.prisma.orders.updateMany({
      where: {
        id: orderId,
        business_id: businessId,
        status: expectedStatus as unknown as PrismaOrderStatus,
        deleted_at: null,
      },
      data,
    });

    if (result.count === 0) return null;

    return this.prisma.orders.findFirst({
      where: { id: orderId, business_id: businessId, deleted_at: null },
      include: {
        client: true,
        shipping_address: true,
        shipments: true,
        payments: true,
      },
    });
  }

  /**
   * Get orders for a specific client, paginated.
   */
  async findOrdersByClient(
    businessId: string,
    clientId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<PaginatedOrders> {
    return this.findOrders(businessId, { clientId, page, limit });
  }

  /**
   * Get the N most recent orders for a client.
   */
  async findRecentOrdersForClient(
    businessId: string,
    clientId: string,
    limit: number = 5,
  ): Promise<orders[]> {
    return this.prisma.orders.findMany({
      where: {
        business_id: businessId,
        client_id: clientId,
        deleted_at: null,
      },
      include: {
        shipments: { select: { id: true, status: true, tracking_number: true, provider: true } },
      },
      orderBy: { placed_at: 'desc' },
      take: limit,
    });
  }

  /**
   * Derive the next order number for this business and year.
   * Format: ORD-YYYY-NNNNN
   *
   * This is a derivation, not an allocation: nothing is reserved, so two
   * requests reading at the same moment get the same number. The unique
   * constraint on (business_id, order_number) is what arbitrates, and
   * `createWithSequentialNumber` re-derives for whichever caller loses. The
   * docstring here used to claim a raw atomic increment inside a transaction —
   * it was neither, and the count-plus-one below is what actually shipped.
   *
   * Reads the highest number issued rather than counting rows. Counting is
   * wrong the moment the sequence has a gap — a failed insert that consumed a
   * number, or a hard-deleted row — because it then re-issues a number that is
   * already taken and every subsequent create collides on it forever. It is
   * also a full count of the tenant's year on every single order, where this is
   * one backward index scan on the unique index.
   */
  async getNextOrderNumber(businessId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `ORD-${year}-`;

    // Zero-padded to a fixed width, so lexicographic order is numeric order
    // and the index can answer this by seeking to the end of the prefix range.
    const latest = await this.prisma.orders.findFirst({
      where: {
        business_id: businessId,
        order_number: { startsWith: prefix },
      },
      orderBy: { order_number: 'desc' },
      select: { order_number: true },
    });

    // Anything that does not parse — a legacy or hand-written number — falls
    // back to zero. `NaN + 1` would render as "ORD-2026-000NaN" and then
    // collide with itself on every subsequent order.
    const stored = typeof latest?.order_number === 'string' ? latest.order_number : '';
    const highest = Number.parseInt(stored.slice(prefix.length), 10);
    const nextNumber = (Number.isFinite(highest) ? highest : 0) + 1;

    return `${prefix}${String(nextNumber).padStart(5, '0')}`;
  }

  /**
   * Count orders by status for a business.
   */
  async countOrdersByStatus(businessId: string): Promise<Record<string, number>> {
    const groups = await this.prisma.orders.groupBy({
      by: ['status'],
      where: {
        business_id: businessId,
        deleted_at: null,
      },
      _count: { status: true },
    });

    const result: Record<string, number> = {};
    for (const group of groups) {
      result[group.status] = group._count.status;
    }
    return result;
  }

  /**
   * Get total order count for a client within a business.
   */
  async countOrdersForClient(
    businessId: string,
    clientId: string,
  ): Promise<number> {
    return this.prisma.orders.count({
      where: {
        business_id: businessId,
        client_id: clientId,
        deleted_at: null,
      },
    });
  }
}
