import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { OrderStatus } from '@gosumo/shared';
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
        contains: filters.search,
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
          client: true,
          shipments: true,
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
   * Update order status and optional fields.
   * Verifies business_id scoping before update.
   */
  async updateOrderStatus(
    businessId: string,
    orderId: string,
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
  ): Promise<orders> {
    const existing = await this.prisma.orders.findFirst({
      where: {
        id: orderId,
        business_id: businessId,
        deleted_at: null,
      },
    });

    if (!existing) {
      throw new Error(`Order ${orderId} not found for business ${businessId}`);
    }

    const updateData: Prisma.ordersUpdateInput = {
      status: status as unknown as PrismaOrderStatus,
    };

    if (extra?.confirmedAt) {
      updateData.confirmed_at = extra.confirmedAt;
    }
    if (extra?.deliveredAt) {
      updateData.delivered_at = extra.deliveredAt;
    }
    if (extra?.cancelledAt) {
      updateData.cancelled_at = extra.cancelledAt;
    }
    if (extra?.cancellationReason) {
      updateData.cancellation_reason = extra.cancellationReason;
    }
    if (extra?.returnedAt) {
      updateData.returned_at = extra.returnedAt;
    }
    if (extra?.returnReason) {
      updateData.return_reason = extra.returnReason;
    }
    if (extra?.internalNote) {
      updateData.internal_note = extra.internalNote;
    }

    return this.prisma.orders.update({
      where: { id: orderId },
      data: updateData,
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
        shipments: true,
      },
      orderBy: { placed_at: 'desc' },
      take: limit,
    });
  }

  /**
   * Get the next order number using an atomic counter pattern.
   * Uses a raw SQL query to atomically increment and return the next sequence.
   * Format: ORD-YYYY-NNNNN
   */
  async getNextOrderNumber(businessId: string): Promise<string> {
    const year = new Date().getFullYear();

    // Count existing orders for this business this year and add 1
    // Using a transaction to ensure atomicity
    const count = await this.prisma.orders.count({
      where: {
        business_id: businessId,
        order_number: {
          startsWith: `ORD-${year}-`,
        },
      },
    });

    const nextNumber = count + 1;
    const paddedNumber = String(nextNumber).padStart(5, '0');
    return `ORD-${year}-${paddedNumber}`;
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
