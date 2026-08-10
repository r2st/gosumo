import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { CouponService } from './coupon.service';
import { PrismaService } from '../../common/services/prisma.service';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  DiscountType,
} from '@gosumo/shared';
import type {
  PaymentSuccessEvent,
  PaymentRefundEvent,
} from '@gosumo/shared';
import type { OrderLineItem } from './dto';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const ORDER_ID = '00000000-0000-4000-8000-000000000003';
const ITEM_ID = '00000000-0000-4000-8000-000000000004';
const PAYMENT_ID = '00000000-0000-4000-8000-000000000006';
const REFUND_ID = '00000000-0000-4000-8000-000000000007';
const COUPON_ID = '00000000-0000-4000-8000-000000000008';
const SHIPPING_OPTION_ID = '00000000-0000-4000-8000-000000000009';

const MOCK_LINE_ITEMS: OrderLineItem[] = [
  {
    itemId: ITEM_ID,
    variantId: null,
    name: 'Test Product',
    sku: 'TEST-001',
    quantity: 2,
    unitPrice: 50000, // 500.00 INR in paise
    totalPrice: 100000,
    taxAmount: 18000, // 18% GST
  },
];

function createMockOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    conversation_id: null,
    order_number: 'ORD-2026-00001',
    status: OrderStatus.CONFIRMED,
    line_items: MOCK_LINE_ITEMS,
    subtotal: 1000.0,
    discount_amount: 0,
    tax_amount: 180.0,
    shipping_fee: 0,
    total: 1180.0,
    currency: 'INR',
    shipping_address_id: null,
    shipping_option_id: null,
    customer_note: null,
    internal_note: null,
    discount_code: null,
    discount_type: null,
    discount_value: null,
    placed_at: new Date('2026-06-27T10:00:00Z'),
    confirmed_at: new Date('2026-06-27T10:00:00Z'),
    delivered_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    returned_at: null,
    return_reason: null,
    metadata: {},
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function createMockCatalogItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    business_id: BUSINESS_ID,
    category_id: null,
    type: 'PRODUCT',
    name: 'Test Product',
    slug: 'test-product',
    description: 'A test product',
    short_description: null,
    price: 500.0,
    compare_price: null,
    currency: 'INR',
    tax_rate: 0.18,
    tax_inclusive: false,
    sku: 'TEST-001',
    barcode: null,
    stock_quantity: 100,
    track_inventory: true,
    allow_backorder: false,
    low_stock_threshold: 10,
    weight_grams: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    images: [],
    tags: [],
    ai_description: null,
    is_active: true,
    is_featured: false,
    sort_order: 0,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    variants: [],
    ...overrides,
  };
}

// Strongly-typed Prisma mock so member access is not `| undefined`.
interface PrismaMock {
  catalog_items: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  catalog_variants: {
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  shipments: { create: jest.Mock };
  shipping_options: { findFirst: jest.Mock };
  /** Stock reservation and restoration are issued as one batched transaction. */
  $transaction: jest.Mock;
}

// ─────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────

describe('OrderService', () => {
  let service: OrderService;
  let repository: jest.Mocked<OrderRepository>;
  let couponService: jest.Mocked<CouponService>;
  let prisma: PrismaMock;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository = {
      createOrder: jest.fn(),
      findOrderById: jest.fn(),
      findOrders: jest.fn(),
      updateOrderStatus: jest.fn(),
      findOrdersByClient: jest.fn(),
      findRecentOrdersForClient: jest.fn(),
      getNextOrderNumber: jest.fn(),
      countOrdersByStatus: jest.fn(),
      countOrdersForClient: jest.fn(),
    };

    prisma = {
      catalog_items: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      catalog_variants: {
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      shipments: { create: jest.fn() },
      shipping_options: { findFirst: jest.fn() },
      // The real client executes the queued PrismaPromises; the mock resolves
      // them so the assertions below can inspect what was queued.
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };

    const mockCouponService = {
      validateAndComputeDiscount: jest.fn(),
      redeem: jest.fn(),
    };

    const mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: OrderRepository, useValue: mockRepository },
        { provide: CouponService, useValue: mockCouponService },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<OrderService>(OrderService);
    repository = module.get(OrderRepository) as jest.Mocked<OrderRepository>;
    couponService = module.get(CouponService) as jest.Mocked<CouponService>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
  });

  // ─────────────────────────────────────────────
  // createOrder
  // ─────────────────────────────────────────────

  describe('createOrder', () => {
    it('should snapshot prices from catalog and create order with correct totals', async () => {
      const catalogItem = createMockCatalogItem();
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      prisma.catalog_items.update.mockResolvedValue(catalogItem);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');

      const mockOrder = createMockOrder();
      repository.createOrder.mockResolvedValue(mockOrder as never);

      const dto = {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 2 }],
        paymentMethod: PaymentMethod.COD,
      };

      const result = await service.createOrder(BUSINESS_ID, dto);

      expect(repository.createOrder).toHaveBeenCalledTimes(1);
      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall).toBeDefined();
      expect(createCall?.businessId).toBe(BUSINESS_ID);
      expect(createCall?.clientId).toBe(CLIENT_ID);
      expect(createCall?.orderNumber).toBe('ORD-2026-00001');
      // subtotal 1000 + tax 180 = 1180
      expect(createCall?.subtotal).toBe(1000);
      expect(createCall?.taxAmount).toBe(180);
      expect(createCall?.total).toBe(1180);

      expect(result.orderNumber).toBe('ORD-2026-00001');
      expect(result.businessId).toBe(BUSINESS_ID);
    });

    it('fetches every line item in a single catalog query, not one per line', async () => {
      // Guards the N+1 that order creation used to do: a findFirst per line
      // meant a 10-item cart made 10 sequential round trips before any order
      // row was written.
      const SECOND_ITEM_ID = '00000000-0000-4000-a000-0000000000aa';
      const first = createMockCatalogItem();
      const second = createMockCatalogItem({ id: SECOND_ITEM_ID, track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([first, second]);
      prisma.catalog_items.update.mockResolvedValue(first);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00002');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [
          { itemId: ITEM_ID, quantity: 1 },
          { itemId: SECOND_ITEM_ID, quantity: 3 },
        ],
        paymentMethod: PaymentMethod.COD,
      });

      expect(prisma.catalog_items.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.catalog_items.findFirst).not.toHaveBeenCalled();

      const where = prisma.catalog_items.findMany.mock.calls[0]?.[0]?.where;
      expect(where.id.in).toEqual(expect.arrayContaining([ITEM_ID, SECOND_ITEM_ID]));
      // Still tenant-scoped and still excludes inactive/deleted rows.
      expect(where).toMatchObject({
        business_id: BUSINESS_ID,
        is_active: true,
        deleted_at: null,
      });
    });

    it('deduplicates repeated item ids into one fetched id', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00003');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [
          { itemId: ITEM_ID, quantity: 1 },
          { itemId: ITEM_ID, quantity: 2 },
        ],
        paymentMethod: PaymentMethod.COD,
      });

      const where = prisma.catalog_items.findMany.mock.calls[0]?.[0]?.where;
      expect(where.id.in).toEqual([ITEM_ID]);

      // Both lines are still priced — dedup is only about the fetch.
      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall?.lineItems).toHaveLength(2);
    });

    it('still rejects when one of several items is missing from the batch', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      // Only the first item comes back; the second is inactive or foreign.
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);

      await expect(
        service.createOrder(BUSINESS_ID, {
          clientId: CLIENT_ID,
          items: [
            { itemId: ITEM_ID, quantity: 1 },
            { itemId: '00000000-0000-4000-a000-0000000000bb', quantity: 1 },
          ],
          paymentMethod: PaymentMethod.COD,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should generate unique order number in ORD-YYYY-NNNNN format', async () => {
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00042');

      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);

      const mockOrder = createMockOrder({ order_number: 'ORD-2026-00042' });
      repository.createOrder.mockResolvedValue(mockOrder as never);

      const result = await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 1 }],
        paymentMethod: PaymentMethod.COD,
      });

      expect(result.orderNumber).toBe('ORD-2026-00042');
    });

    it('should set COD orders to CONFIRMED immediately', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');

      const mockOrder = createMockOrder({ status: OrderStatus.CONFIRMED });
      repository.createOrder.mockResolvedValue(mockOrder as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 1 }],
        paymentMethod: PaymentMethod.COD,
      });

      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall?.status).toBe(OrderStatus.CONFIRMED);
    });

    it('should set ONLINE payment orders to DRAFT status', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');

      const mockOrder = createMockOrder({ status: OrderStatus.DRAFT });
      repository.createOrder.mockResolvedValue(mockOrder as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 1 }],
        paymentMethod: PaymentMethod.CARD,
      });

      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall?.status).toBe(OrderStatus.DRAFT);
    });

    it('should emit order.created event on success', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 1 }],
        paymentMethod: PaymentMethod.COD,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.created',
        expect.objectContaining({
          type: 'order.created',
          businessId: BUSINESS_ID,
          orderId: ORDER_ID,
          clientId: CLIENT_ID,
        }),
      );
    });

    it('should throw BadRequestException if catalog item not found', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([]);

      await expect(
        service.createOrder(BUSINESS_ID, {
          clientId: CLIENT_ID,
          items: [{ itemId: 'nonexistent-id', quantity: 1 }],
          paymentMethod: PaymentMethod.COD,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if insufficient stock', async () => {
      const catalogItem = createMockCatalogItem({ stock_quantity: 1 });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);

      await expect(
        service.createOrder(BUSINESS_ID, {
          clientId: CLIENT_ID,
          items: [{ itemId: ITEM_ID, quantity: 10 }],
          paymentMethod: PaymentMethod.COD,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reserve stock when track_inventory is true', async () => {
      const catalogItem = createMockCatalogItem({
        stock_quantity: 100,
        track_inventory: true,
      });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      prisma.catalog_items.update.mockResolvedValue(catalogItem);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 3 }],
        paymentMethod: PaymentMethod.COD,
      });

      // The decrement must be tenant-scoped: an item id alone would let a
      // crafted order move another business's stock.
      expect(prisma.catalog_items.update).toHaveBeenCalledWith({
        where: { id: ITEM_ID, business_id: BUSINESS_ID },
        data: { stock_quantity: { decrement: 3 } },
      });
    });

    it('should apply a coupon discount and redeem it', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      couponService.validateAndComputeDiscount.mockResolvedValue({
        couponId: COUPON_ID,
        code: 'DIWALI20',
        type: DiscountType.PERCENT,
        value: 20,
        discountPaise: 20000, // 20% of 1000 INR
      });

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 2 }],
        paymentMethod: PaymentMethod.COD,
        discountCode: 'DIWALI20',
      });

      expect(couponService.validateAndComputeDiscount).toHaveBeenCalledWith(
        BUSINESS_ID,
        'DIWALI20',
        CLIENT_ID,
        100000,
      );
      expect(couponService.redeem).toHaveBeenCalledWith(BUSINESS_ID, COUPON_ID);

      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall?.discountAmount).toBe(200); // 20000 paise = 200 INR
      expect(createCall?.discountCode).toBe('DIWALI20');
      // total = subtotal(1000) - discount(200) + scaled tax(144) + shipping(0)
      expect(createCall?.total).toBe(944);
    });

    it('should add a shipping fee from the chosen shipping option', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      prisma.shipping_options.findFirst.mockResolvedValue({
        id: SHIPPING_OPTION_ID,
        business_id: BUSINESS_ID,
        base_fee: 50,
        min_order_value_for_free: null,
        is_active: true,
        deleted_at: null,
      });
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 2 }],
        paymentMethod: PaymentMethod.COD,
        shippingOptionId: SHIPPING_OPTION_ID,
      });

      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall?.shippingFee).toBe(50);
      // total = subtotal(1000) + tax(180) + shipping(50)
      expect(createCall?.total).toBe(1230);
    });

    it('should waive shipping fee above the free-shipping threshold', async () => {
      const catalogItem = createMockCatalogItem({ track_inventory: false });
      prisma.catalog_items.findMany.mockResolvedValue([catalogItem]);
      prisma.shipping_options.findFirst.mockResolvedValue({
        id: SHIPPING_OPTION_ID,
        business_id: BUSINESS_ID,
        base_fee: 50,
        min_order_value_for_free: 500, // free over 500 INR
        is_active: true,
        deleted_at: null,
      });
      repository.getNextOrderNumber.mockResolvedValue('ORD-2026-00001');
      repository.createOrder.mockResolvedValue(createMockOrder() as never);

      await service.createOrder(BUSINESS_ID, {
        clientId: CLIENT_ID,
        items: [{ itemId: ITEM_ID, quantity: 2 }],
        paymentMethod: PaymentMethod.COD,
        shippingOptionId: SHIPPING_OPTION_ID,
      });

      const createCall = repository.createOrder.mock.calls[0]?.[0];
      expect(createCall?.shippingFee).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // State machine transitions
  // ─────────────────────────────────────────────

  describe('updateOrderStatus (state machine)', () => {
    it('should allow CONFIRMED -> PROCESSING transition', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PROCESSING }) as never,
      );

      const result = await service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
        status: OrderStatus.PROCESSING,
      });

      expect(result.status).toBe(OrderStatus.PROCESSING);
    });

    it('should allow PROCESSING -> PACKED transition', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PROCESSING }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PACKED }) as never,
      );

      const result = await service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
        status: OrderStatus.PACKED,
      });

      expect(result.status).toBe(OrderStatus.PACKED);
    });

    it('should allow PACKED -> SHIPPED transition', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PACKED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );

      const result = await service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
        status: OrderStatus.SHIPPED,
      });

      expect(result.status).toBe(OrderStatus.SHIPPED);
    });

    it('should reject invalid transition: DRAFT -> SHIPPED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DRAFT }) as never,
      );

      await expect(
        service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
          status: OrderStatus.SHIPPED,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid transition: DELIVERED -> CONFIRMED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DELIVERED }) as never,
      );

      await expect(
        service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
          status: OrderStatus.CONFIRMED,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject transition: CANCELLED -> CONFIRMED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );

      await expect(
        service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
          status: OrderStatus.CONFIRMED,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent order', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await expect(
        service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
          status: OrderStatus.PROCESSING,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // cancelOrder
  // ─────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('should cancel a CONFIRMED order successfully', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );
      prisma.catalog_items.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelOrder(BUSINESS_ID, ORDER_ID, {
        reason: 'Customer changed mind',
      });

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.cancelled',
        expect.objectContaining({
          type: 'order.cancelled',
          orderId: ORDER_ID,
          reason: 'Customer changed mind',
        }),
      );
    });

    it('should throw BadRequestException when cancelling a SHIPPED order', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );

      await expect(
        service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'Want to cancel' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when cancelling a DELIVERED order', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DELIVERED }) as never,
      );

      await expect(
        service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'Want to cancel' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when cancelling an already CANCELLED order', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );

      await expect(
        service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'Want to cancel again' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should restore stock on cancellation', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({
          status: OrderStatus.CONFIRMED,
          line_items: MOCK_LINE_ITEMS,
        }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );
      prisma.catalog_items.updateMany.mockResolvedValue({ count: 1 });

      await service.cancelOrder(BUSINESS_ID, ORDER_ID, {
        reason: 'Customer changed mind',
      });

      expect(prisma.catalog_items.updateMany).toHaveBeenCalledWith({
        where: {
          id: ITEM_ID,
          business_id: BUSINESS_ID,
          track_inventory: true,
        },
        data: { stock_quantity: { increment: 2 } },
      });
    });
  });

  // ─────────────────────────────────────────────
  // markPacked
  // ─────────────────────────────────────────────

  describe('markPacked', () => {
    it('should mark PROCESSING order as PACKED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PROCESSING }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PACKED }) as never,
      );

      const result = await service.markPacked(BUSINESS_ID, ORDER_ID, {});

      expect(result.status).toBe(OrderStatus.PACKED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.packed',
        expect.objectContaining({ type: 'order.packed', orderId: ORDER_ID }),
      );
    });

    it('should reject packing a CONFIRMED order (must be PROCESSING first)', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );

      await expect(service.markPacked(BUSINESS_ID, ORDER_ID, {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─────────────────────────────────────────────
  // createShipment
  // ─────────────────────────────────────────────

  describe('createShipment', () => {
    it('should create shipment and transition PACKED to SHIPPED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PACKED }) as never,
      );
      prisma.shipments.create.mockResolvedValue({ id: 'shipment-id' });
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );

      const result = await service.createShipment(BUSINESS_ID, ORDER_ID, {
        trackingId: 'TRACK-123',
        provider: 'SHIPROCKET',
        carrier: 'Delhivery',
      });

      expect(result.status).toBe(OrderStatus.SHIPPED);
      expect(prisma.shipments.create).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.shipped',
        expect.objectContaining({
          type: 'order.shipped',
          orderId: ORDER_ID,
          trackingNumber: 'TRACK-123',
        }),
      );
    });

    it('should reject shipment for non-PACKED order', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );

      await expect(
        service.createShipment(BUSINESS_ID, ORDER_ID, {
          trackingId: 'TRACK-123',
          provider: 'SHIPROCKET',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────
  // returnOrder
  // ─────────────────────────────────────────────

  describe('returnOrder', () => {
    it('should return a DELIVERED order and emit order.returned', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DELIVERED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.RETURNED }) as never,
      );
      prisma.catalog_items.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.returnOrder(BUSINESS_ID, ORDER_ID, {
        reason: 'Damaged on arrival',
      });

      expect(result.status).toBe(OrderStatus.RETURNED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.returned',
        expect.objectContaining({
          type: 'order.returned',
          orderId: ORDER_ID,
          reason: 'Damaged on arrival',
        }),
      );
      // stock restored
      expect(prisma.catalog_items.updateMany).toHaveBeenCalled();
    });

    it('should reject returning a CONFIRMED order', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );

      await expect(
        service.returnOrder(BUSINESS_ID, ORDER_ID, { reason: 'nope' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────

  describe('handlePaymentSuccess', () => {
    it('should confirm a DRAFT order on payment success', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DRAFT }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );

      const event: PaymentSuccessEvent = {
        type: 'payment.success',
        id: 'event-id',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-id',
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        amountPaise: 118000,
        currency: 'INR',
        status: PaymentStatus.SUCCESS,
        gatewayPaymentId: 'gateway-123',
      };

      await service.handlePaymentSuccess(event);

      expect(repository.updateOrderStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        ORDER_ID,
        OrderStatus.CONFIRMED,
        expect.objectContaining({ confirmedAt: expect.any(Date) }),
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.confirmed',
        expect.objectContaining({ type: 'order.confirmed', orderId: ORDER_ID }),
      );
    });

    it('should skip payment success if order is already PROCESSING', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PROCESSING }) as never,
      );

      const event: PaymentSuccessEvent = {
        type: 'payment.success',
        id: 'event-id',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-id',
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        amountPaise: 118000,
        currency: 'INR',
        status: PaymentStatus.SUCCESS,
        gatewayPaymentId: 'gateway-123',
      };

      await service.handlePaymentSuccess(event);

      expect(repository.updateOrderStatus).not.toHaveBeenCalled();
    });

    it('should skip payment success if no orderId in event', async () => {
      const event: PaymentSuccessEvent = {
        type: 'payment.success',
        id: 'event-id',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-id',
        paymentId: PAYMENT_ID,
        clientId: CLIENT_ID,
        amountPaise: 118000,
        currency: 'INR',
        status: PaymentStatus.SUCCESS,
        gatewayPaymentId: 'gateway-123',
      };

      await service.handlePaymentSuccess(event);

      expect(repository.findOrderById).not.toHaveBeenCalled();
    });
  });

  describe('handleRefundCompleted', () => {
    it('should transition CANCELLED order to REFUNDED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.REFUNDED }) as never,
      );

      const event: PaymentRefundEvent = {
        type: 'payment.refund.completed',
        id: 'event-id',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-id',
        refundId: REFUND_ID,
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        amountPaise: 118000,
        currency: 'INR',
        reason: 'Customer cancellation refund',
      };

      await service.handleRefundCompleted(event);

      expect(repository.updateOrderStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        ORDER_ID,
        OrderStatus.REFUNDED,
      );
    });

    it('should skip refund if order is not in CANCELLED status', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CONFIRMED }) as never,
      );

      const event: PaymentRefundEvent = {
        type: 'payment.refund.completed',
        id: 'event-id',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-id',
        refundId: REFUND_ID,
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        amountPaise: 118000,
        currency: 'INR',
      };

      await service.handleRefundCompleted(event);

      expect(repository.updateOrderStatus).not.toHaveBeenCalled();
    });
  });

  describe('handleShippingDelivered', () => {
    it('should transition SHIPPED order to DELIVERED and emit order.delivered', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DELIVERED }) as never,
      );

      await service.handleShippingDelivered({
        businessId: BUSINESS_ID,
        orderId: ORDER_ID,
        deliveredAt: '2026-07-01T10:00:00Z',
      });

      expect(repository.updateOrderStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        ORDER_ID,
        OrderStatus.DELIVERED,
        expect.objectContaining({ deliveredAt: expect.any(Date) }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'order.delivered',
        expect.objectContaining({ type: 'order.delivered', orderId: ORDER_ID }),
      );
    });

    it('should skip if order is not SHIPPED', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PROCESSING }) as never,
      );

      await service.handleShippingDelivered({
        businessId: BUSINESS_ID,
        orderId: ORDER_ID,
      });

      expect(repository.updateOrderStatus).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // getOrderStatusForClient
  // ─────────────────────────────────────────────

  describe('getOrderStatusForClient', () => {
    it('should return AI-friendly status summary with recent orders', async () => {
      const recentOrders = [
        createMockOrder({ order_number: 'ORD-2026-00003', status: OrderStatus.SHIPPED }),
        createMockOrder({ order_number: 'ORD-2026-00002', status: OrderStatus.DELIVERED }),
        createMockOrder({ order_number: 'ORD-2026-00001', status: OrderStatus.CONFIRMED }),
      ];

      repository.findRecentOrdersForClient.mockResolvedValue(recentOrders as never);
      repository.countOrdersForClient.mockResolvedValue(3);

      const result = await service.getOrderStatusForClient(BUSINESS_ID, CLIENT_ID);

      expect(result.clientId).toBe(CLIENT_ID);
      expect(result.totalOrders).toBe(3);
      expect(result.recentOrders).toHaveLength(3);
      expect(result.recentOrders[0]?.orderNumber).toBe('ORD-2026-00003');
      expect(result.order).toBeUndefined();
    });

    it('should include specific order details when orderId is provided', async () => {
      const orderWithShipments = {
        ...createMockOrder({ status: OrderStatus.SHIPPED }),
        shipments: [
          {
            tracking_number: 'TRACK-ABC',
            tracking_url: 'https://track.example.com/TRACK-ABC',
            estimated_delivery_at: new Date('2026-07-01T10:00:00Z'),
          },
        ],
      };

      repository.findRecentOrdersForClient.mockResolvedValue([] as never);
      repository.countOrdersForClient.mockResolvedValue(1);
      repository.findOrderById.mockResolvedValue(orderWithShipments as never);

      const result = await service.getOrderStatusForClient(
        BUSINESS_ID,
        CLIENT_ID,
        ORDER_ID,
      );

      expect(result.order).toBeDefined();
      expect(result.order?.orderNumber).toBe('ORD-2026-00001');
      expect(result.order?.status).toBe(OrderStatus.SHIPPED);
      expect(result.order?.trackingNumber).toBe('TRACK-ABC');
    });
  });

  // ─────────────────────────────────────────────
  // getOrder / listOrders
  // ─────────────────────────────────────────────

  describe('getOrder', () => {
    it('should return order DTO for valid order', async () => {
      repository.findOrderById.mockResolvedValue(createMockOrder() as never);

      const result = await service.getOrder(BUSINESS_ID, ORDER_ID);

      expect(result.id).toBe(ORDER_ID);
      expect(result.orderNumber).toBe('ORD-2026-00001');
    });

    it('should throw NotFoundException for missing order', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await expect(service.getOrder(BUSINESS_ID, ORDER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listOrders', () => {
    it('should return paginated list of orders', async () => {
      repository.findOrders.mockResolvedValue({
        data: [createMockOrder()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      } as never);

      const result = await service.listOrders(BUSINESS_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });

    it('should forward a search term to the repository', async () => {
      repository.findOrders.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await service.listOrders(BUSINESS_ID, { search: 'ORD-2026' });

      expect(repository.findOrders).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ search: 'ORD-2026' }),
      );
    });
  });
});
