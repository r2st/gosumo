/**
 * OrderRepository unit tests.
 *
 * Two things in here carry real risk and both are branch-heavy:
 *
 *   - `findOrders` builds an optional-field `where`. An omitted filter must not
 *     appear at all, and the date range must degrade correctly when only one
 *     bound is given (a half-open range, not a missing one).
 *   - `updateOrderStatus` re-reads the row under the tenant scope before
 *     writing, which is the guard that stops a cross-tenant order id from being
 *     mutated. Its `extra` patch is also all-optional.
 *
 * Every query must carry `business_id`; that is asserted throughout.
 *
 * PrismaService is mocked — assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { OrderStatus, ResourceNotFoundError } from '@gosumo/shared';

import { OrderRepository, type CreateOrderData } from './order.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS = '00000000-0000-4000-a000-000000000002';
const ORDER_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';

function orderData(overrides: Partial<CreateOrderData> = {}): CreateOrderData {
  return {
    businessId: BUSINESS_ID,
    clientId: CLIENT_ID,
    orderNumber: 'ORD-2026-00001',
    status: OrderStatus.DRAFT,
    lineItems: [],
    subtotal: 100000,
    discountAmount: 0,
    taxAmount: 18000,
    shippingFee: 5000,
    total: 123000,
    currency: 'INR',
    ...overrides,
  };
}

describe('OrderRepository', () => {
  let repository: OrderRepository;
  let prisma: {
    orders: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      groupBy: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      orders: {
        create: jest.fn().mockResolvedValue({ id: ORDER_ID }),
        findFirst: jest.fn().mockResolvedValue({ id: ORDER_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: ORDER_ID }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OrderRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get<OrderRepository>(OrderRepository);
  });

  /** The row Prisma was asked to insert. */
  function createdRow(): Record<string, unknown> {
    return prisma.orders.create.mock.calls[0]![0].data;
  }

  /** The `where` handed to `orders.findMany`. */
  function listedWhere(): Record<string, unknown> {
    return prisma.orders.findMany.mock.calls[0]![0].where;
  }

  // ─────────────────────────────────────────────
  // createOrder
  // ─────────────────────────────────────────────

  describe('createOrder', () => {
    it('persists the financial snapshot and tenant scope', async () => {
      await repository.createOrder(orderData());

      expect(createdRow()).toMatchObject({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
        order_number: 'ORD-2026-00001',
        subtotal: 100000,
        discount_amount: 0,
        tax_amount: 18000,
        shipping_fee: 5000,
        total: 123000,
        currency: 'INR',
      });
    });

    it('stamps confirmed_at when the order is created already CONFIRMED', async () => {
      // COD orders skip the payment link and land here pre-confirmed.
      await repository.createOrder(orderData({ status: OrderStatus.CONFIRMED }));

      expect(createdRow().confirmed_at).toBeInstanceOf(Date);
    });

    it('leaves confirmed_at null for a DRAFT order', async () => {
      await repository.createOrder(orderData({ status: OrderStatus.DRAFT }));

      expect(createdRow().confirmed_at).toBeNull();
    });

    it('nulls every optional association the caller omitted', async () => {
      await repository.createOrder(orderData());

      expect(createdRow()).toMatchObject({
        conversation_id: null,
        discount_code: null,
        discount_type: null,
        discount_value: null,
        shipping_address_id: null,
        shipping_option_id: null,
        customer_note: null,
      });
    });

    it('persists the optional associations when supplied', async () => {
      await repository.createOrder(
        orderData({
          conversationId: 'conv-1',
          discountCode: 'DIWALI',
          discountType: 'PERCENT',
          discountValue: 10,
          shippingAddressId: 'addr-1',
          shippingOptionId: 'ship-1',
          customerNote: 'Leave at gate',
        }),
      );

      expect(createdRow()).toMatchObject({
        conversation_id: 'conv-1',
        discount_code: 'DIWALI',
        discount_type: 'PERCENT',
        discount_value: 10,
        shipping_address_id: 'addr-1',
        shipping_option_id: 'ship-1',
        customer_note: 'Leave at gate',
      });
    });

    it('defaults metadata to an empty object rather than null', async () => {
      // The column is non-nullable JSON; a null here fails the insert.
      await repository.createOrder(orderData());

      expect(createdRow().metadata).toEqual({});
    });

    it('keeps supplied metadata', async () => {
      await repository.createOrder(orderData({ metadata: { source: 'whatsapp' } }));

      expect(createdRow().metadata).toEqual({ source: 'whatsapp' });
    });

    it('keeps a zero discount value distinct from an absent one', async () => {
      await repository.createOrder(orderData({ discountValue: 0 }));

      expect(createdRow().discount_value).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // findOrderById
  // ─────────────────────────────────────────────

  describe('findOrderById', () => {
    it('scopes the lookup to the tenant and skips soft-deleted rows', async () => {
      await repository.findOrderById(BUSINESS_ID, ORDER_ID);

      expect(prisma.orders.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ORDER_ID, business_id: BUSINESS_ID, deleted_at: null },
        }),
      );
    });

    it('hydrates the relations the order detail view needs', async () => {
      await repository.findOrderById(BUSINESS_ID, ORDER_ID);

      expect(prisma.orders.findFirst.mock.calls[0]![0].include).toEqual({
        client: true,
        shipping_address: true,
        shipments: true,
        payments: true,
      });
    });

    it('returns null when the order belongs to another tenant', async () => {
      prisma.orders.findFirst.mockResolvedValue(null);

      await expect(repository.findOrderById(OTHER_BUSINESS, ORDER_ID)).resolves.toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // findOrders — pagination and filters
  // ─────────────────────────────────────────────

  describe('findOrders', () => {
    it('defaults to page 1 / limit 20, newest first', async () => {
      const result = await repository.findOrders(BUSINESS_ID, {});

      expect(prisma.orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20, orderBy: { placed_at: 'desc' } }),
      );
      expect(result).toMatchObject({ page: 1, limit: 20 });
    });

    it('translates page/limit into skip/take', async () => {
      await repository.findOrders(BUSINESS_ID, { page: 4, limit: 15 });

      expect(prisma.orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 45, take: 15 }),
      );
    });

    it('scopes to the tenant and excludes soft-deleted rows', async () => {
      await repository.findOrders(BUSINESS_ID, {});

      expect(listedWhere()).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
      expect(prisma.orders.count).toHaveBeenCalledWith({ where: listedWhere() });
    });

    it('filters by status when supplied', async () => {
      await repository.findOrders(BUSINESS_ID, { status: OrderStatus.SHIPPED });

      expect(listedWhere()).toMatchObject({ status: OrderStatus.SHIPPED });
    });

    it('filters by client when supplied', async () => {
      await repository.findOrders(BUSINESS_ID, { clientId: CLIENT_ID });

      expect(listedWhere()).toMatchObject({ client_id: CLIENT_ID });
    });

    it('searches the order number case-insensitively', async () => {
      await repository.findOrders(BUSINESS_ID, { search: '00042' });

      expect(listedWhere()).toMatchObject({
        order_number: { contains: '00042', mode: 'insensitive' },
      });
    });

    it('omits filter clauses that were not supplied', async () => {
      await repository.findOrders(BUSINESS_ID, {});

      const where = listedWhere();
      expect(where).not.toHaveProperty('status');
      expect(where).not.toHaveProperty('client_id');
      expect(where).not.toHaveProperty('order_number');
      expect(where).not.toHaveProperty('placed_at');
    });

    it('builds a closed date range from both bounds', async () => {
      const dateFrom = new Date('2026-01-01T00:00:00Z');
      const dateTo = new Date('2026-02-01T00:00:00Z');

      await repository.findOrders(BUSINESS_ID, { dateFrom, dateTo });

      expect(listedWhere()).toMatchObject({ placed_at: { gte: dateFrom, lte: dateTo } });
    });

    it('builds an open-ended range from dateFrom alone', async () => {
      const dateFrom = new Date('2026-01-01T00:00:00Z');

      await repository.findOrders(BUSINESS_ID, { dateFrom });

      expect(listedWhere().placed_at).toEqual({ gte: dateFrom });
    });

    it('builds an open-started range from dateTo alone', async () => {
      const dateTo = new Date('2026-02-01T00:00:00Z');

      await repository.findOrders(BUSINESS_ID, { dateTo });

      expect(listedWhere().placed_at).toEqual({ lte: dateTo });
    });

    it('hydrates the relations the list view renders', async () => {
      await repository.findOrders(BUSINESS_ID, {});

      expect(prisma.orders.findMany.mock.calls[0]![0].include).toEqual({
        client: true,
        shipments: true,
      });
    });

    it('rounds a partial final page up', async () => {
      prisma.orders.count.mockResolvedValue(41);

      const result = await repository.findOrders(BUSINESS_ID, { limit: 20 });

      expect(result.totalPages).toBe(3);
      expect(result.total).toBe(41);
    });

    it('combines every filter into one clause', async () => {
      const dateFrom = new Date('2026-01-01T00:00:00Z');

      await repository.findOrders(BUSINESS_ID, {
        status: OrderStatus.CONFIRMED,
        clientId: CLIENT_ID,
        search: 'ORD',
        dateFrom,
      });

      expect(listedWhere()).toMatchObject({
        business_id: BUSINESS_ID,
        deleted_at: null,
        status: OrderStatus.CONFIRMED,
        client_id: CLIENT_ID,
        order_number: { contains: 'ORD', mode: 'insensitive' },
        placed_at: { gte: dateFrom },
      });
    });
  });

  // ─────────────────────────────────────────────
  // updateOrderStatus
  // ─────────────────────────────────────────────

  describe('updateOrderStatus', () => {
    it('refuses to write when the order is not visible to the tenant', async () => {
      // This read is the cross-tenant guard — without it a foreign order id
      // would be mutated by the update below.
      prisma.orders.findFirst.mockResolvedValue(null);

      const error = await repository
        .updateOrderStatus(OTHER_BUSINESS, ORDER_ID, OrderStatus.CANCELLED)
        .then(
          () => null,
          (err: unknown) => err,
        );

      // The order id and the tenant that asked for it live in log-only
      // context; the message itself stays free of both.
      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).message).toBe('Order not found');
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Order',
        resourceId: ORDER_ID,
        businessId: OTHER_BUSINESS,
      });
      expect(prisma.orders.update).not.toHaveBeenCalled();
    });

    it('checks visibility under the tenant scope before writing', async () => {
      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.PROCESSING);

      expect(prisma.orders.findFirst).toHaveBeenCalledWith({
        where: { id: ORDER_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('writes the status alone when no extra fields are supplied', async () => {
      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.PROCESSING);

      expect(prisma.orders.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ORDER_ID, business_id: BUSINESS_ID },
          data: { status: OrderStatus.PROCESSING },
        }),
      );
    });

    it('stamps confirmed_at when supplied', async () => {
      const confirmedAt = new Date('2026-03-01T10:00:00Z');

      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.CONFIRMED, {
        confirmedAt,
      });

      expect(prisma.orders.update.mock.calls[0]![0].data).toMatchObject({ confirmed_at: confirmedAt });
    });

    it('stamps delivered_at when supplied', async () => {
      const deliveredAt = new Date('2026-03-05T10:00:00Z');

      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.DELIVERED, {
        deliveredAt,
      });

      expect(prisma.orders.update.mock.calls[0]![0].data).toMatchObject({
        delivered_at: deliveredAt,
      });
    });

    it('records the cancellation timestamp and reason together', async () => {
      const cancelledAt = new Date('2026-03-02T10:00:00Z');

      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.CANCELLED, {
        cancelledAt,
        cancellationReason: 'Out of stock',
      });

      expect(prisma.orders.update.mock.calls[0]![0].data).toMatchObject({
        cancelled_at: cancelledAt,
        cancellation_reason: 'Out of stock',
      });
    });

    it('records the return timestamp and reason together', async () => {
      const returnedAt = new Date('2026-03-10T10:00:00Z');

      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.REFUNDED, {
        returnedAt,
        returnReason: 'Damaged',
      });

      expect(prisma.orders.update.mock.calls[0]![0].data).toMatchObject({
        returned_at: returnedAt,
        return_reason: 'Damaged',
      });
    });

    it('records an internal note', async () => {
      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.PROCESSING, {
        internalNote: 'Called the buyer',
      });

      expect(prisma.orders.update.mock.calls[0]![0].data).toMatchObject({
        internal_note: 'Called the buyer',
      });
    });

    it('ignores an empty extra object', async () => {
      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.PROCESSING, {});

      expect(prisma.orders.update.mock.calls[0]![0].data).toEqual({
        status: OrderStatus.PROCESSING,
      });
    });

    it('writes every extra field at once', async () => {
      const now = new Date('2026-03-02T10:00:00Z');

      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.REFUNDED, {
        confirmedAt: now,
        deliveredAt: now,
        cancelledAt: now,
        cancellationReason: 'reason',
        returnedAt: now,
        returnReason: 'return',
        internalNote: 'note',
      });

      expect(prisma.orders.update.mock.calls[0]![0].data).toEqual({
        status: OrderStatus.REFUNDED,
        confirmed_at: now,
        delivered_at: now,
        cancelled_at: now,
        cancellation_reason: 'reason',
        returned_at: now,
        return_reason: 'return',
        internal_note: 'note',
      });
    });

    it('hydrates the full order on the way out', async () => {
      await repository.updateOrderStatus(BUSINESS_ID, ORDER_ID, OrderStatus.PROCESSING);

      expect(prisma.orders.update.mock.calls[0]![0].include).toEqual({
        client: true,
        shipping_address: true,
        shipments: true,
        payments: true,
      });
    });
  });

  // ─────────────────────────────────────────────
  // Client-scoped reads
  // ─────────────────────────────────────────────

  describe('findOrdersByClient', () => {
    it('delegates to findOrders with the client filter applied', async () => {
      await repository.findOrdersByClient(BUSINESS_ID, CLIENT_ID, 2, 5);

      expect(listedWhere()).toMatchObject({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
        deleted_at: null,
      });
      expect(prisma.orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });

    it('defaults to the first page of 20', async () => {
      await repository.findOrdersByClient(BUSINESS_ID, CLIENT_ID);

      expect(prisma.orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });
  });

  describe('findRecentOrdersForClient', () => {
    it('defaults to the five most recent orders', async () => {
      await repository.findRecentOrdersForClient(BUSINESS_ID, CLIENT_ID);

      expect(prisma.orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { business_id: BUSINESS_ID, client_id: CLIENT_ID, deleted_at: null },
          orderBy: { placed_at: 'desc' },
          take: 5,
        }),
      );
    });

    it('honours an explicit limit', async () => {
      await repository.findRecentOrdersForClient(BUSINESS_ID, CLIENT_ID, 2);

      expect(prisma.orders.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    });
  });

  // ─────────────────────────────────────────────
  // Order numbering and counts
  // ─────────────────────────────────────────────

  describe('getNextOrderNumber', () => {
    /** The row the "highest issued so far" lookup returns. */
    const latest = (n: string | null) =>
      prisma.orders.findFirst.mockResolvedValue(n ? { order_number: n } : null);

    it('produces a zero-padded ORD-YYYY-NNNNN number for the first order', async () => {
      latest(null);
      const year = new Date().getFullYear();

      await expect(repository.getNextOrderNumber(BUSINESS_ID)).resolves.toBe(
        `ORD-${year}-00001`,
      );
    });

    it('continues from the highest number issued', async () => {
      const year = new Date().getFullYear();
      latest(`ORD-${year}-00041`);

      await expect(repository.getNextOrderNumber(BUSINESS_ID)).resolves.toBe(
        `ORD-${year}-00042`,
      );
    });

    it('reads the highest issued rather than counting rows', async () => {
      // Counting re-issues a number the moment the sequence has a gap — a
      // create that consumed a number and failed, or a hard-deleted row — and
      // then every subsequent order collides on it, permanently.
      const year = new Date().getFullYear();
      latest(`ORD-${year}-00100`);

      await expect(repository.getNextOrderNumber(BUSINESS_ID)).resolves.toBe(
        `ORD-${year}-00101`,
      );
      expect(prisma.orders.count).not.toHaveBeenCalled();
    });

    it('seeks this tenant’s highest number for the current year', async () => {
      const year = new Date().getFullYear();
      latest(null);

      await repository.getNextOrderNumber(BUSINESS_ID);

      expect(prisma.orders.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          order_number: { startsWith: `ORD-${year}-` },
        },
        orderBy: { order_number: 'desc' },
        select: { order_number: true },
      });
    });

    it('widens past five digits rather than truncating', async () => {
      const year = new Date().getFullYear();
      latest(`ORD-${year}-99999`);

      await expect(repository.getNextOrderNumber(BUSINESS_ID)).resolves.toBe(
        `ORD-${year}-100000`,
      );
    });

    it('keeps ordering numerically once the width has grown', async () => {
      // Fixed-width padding is what makes the lexicographic `desc` seek
      // correct; past the width it still holds because the longer string
      // sorts above the shorter one at the first differing digit.
      const year = new Date().getFullYear();
      latest(`ORD-${year}-100000`);

      await expect(repository.getNextOrderNumber(BUSINESS_ID)).resolves.toBe(
        `ORD-${year}-100001`,
      );
    });

    it('restarts at one rather than crashing on an unparseable stored number', async () => {
      const year = new Date().getFullYear();
      latest(`ORD-${year}-legacy`);

      await expect(repository.getNextOrderNumber(BUSINESS_ID)).resolves.toBe(
        `ORD-${year}-00001`,
      );
    });
  });

  describe('countOrdersByStatus', () => {
    it('folds the grouped rows into a status→count map', async () => {
      prisma.orders.groupBy.mockResolvedValue([
        { status: 'CONFIRMED', _count: { status: 3 } },
        { status: 'SHIPPED', _count: { status: 1 } },
      ]);

      await expect(repository.countOrdersByStatus(BUSINESS_ID)).resolves.toEqual({
        CONFIRMED: 3,
        SHIPPED: 1,
      });
    });

    it('returns an empty map when the tenant has no orders', async () => {
      prisma.orders.groupBy.mockResolvedValue([]);

      await expect(repository.countOrdersByStatus(BUSINESS_ID)).resolves.toEqual({});
    });

    it('groups within the tenant scope, excluding soft-deleted rows', async () => {
      await repository.countOrdersByStatus(BUSINESS_ID);

      expect(prisma.orders.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { business_id: BUSINESS_ID, deleted_at: null },
        _count: { status: true },
      });
    });
  });

  describe('countOrdersForClient', () => {
    it('counts a client’s live orders within the tenant', async () => {
      prisma.orders.count.mockResolvedValue(6);

      await expect(repository.countOrdersForClient(BUSINESS_ID, CLIENT_ID)).resolves.toBe(6);
      expect(prisma.orders.count).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, client_id: CLIENT_ID, deleted_at: null },
      });
    });
  });
});
