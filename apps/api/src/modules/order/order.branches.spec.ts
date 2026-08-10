/**
 * Branch coverage for OrderService.
 *
 * `order.spec.ts` walks the lifecycle: create, transition, cancel, pack, ship,
 * return. What it does not reach is the arithmetic and fallback machinery those
 * paths sit on — variant price/SKU resolution, tax-inclusive extraction, the
 * inventory guards that decide whether stock is touched at all, and the three
 * event handlers' error and precondition arms.
 *
 * Money is asserted in paise at the boundary the repository sees (rupees), since
 * that conversion is where a rounding slip would actually reach the database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { CouponService } from './coupon.service';
import { PrismaService } from '../../common/services/prisma.service';
import { OrderStatus, PaymentMethod } from '@gosumo/shared';
import type { PaymentSuccessEvent, PaymentRefundEvent } from '@gosumo/shared';
import type { OrderLineItem } from './dto';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const ORDER_ID = '00000000-0000-4000-8000-000000000003';
const ITEM_ID = '00000000-0000-4000-8000-000000000004';
const VARIANT_ID = '00000000-0000-4000-8000-000000000005';
const SHIPPING_OPTION_ID = '00000000-0000-4000-8000-000000000009';

const MOCK_LINE_ITEMS: OrderLineItem[] = [
  {
    itemId: ITEM_ID,
    variantId: null,
    name: 'Test Product',
    sku: 'TEST-001',
    quantity: 2,
    unitPrice: 50000,
    totalPrice: 100000,
    taxAmount: 18000,
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
    confirmed_at: null,
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
    name: 'Test Product',
    price: 500.0,
    currency: 'INR',
    tax_rate: 0.18,
    tax_inclusive: false,
    sku: 'TEST-001',
    stock_quantity: 100,
    track_inventory: true,
    allow_backorder: false,
    is_active: true,
    variants: [],
    ...overrides,
  };
}

function createMockVariant(overrides: Record<string, unknown> = {}) {
  return {
    id: VARIANT_ID,
    business_id: BUSINESS_ID,
    item_id: ITEM_ID,
    name: 'Large',
    sku: 'TEST-001-L',
    price: 600.0,
    stock_quantity: 50,
    is_active: true,
    ...overrides,
  };
}

interface PrismaMock {
  catalog_items: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  catalog_variants: { update: jest.Mock; updateMany: jest.Mock };
  shipments: { create: jest.Mock };
  shipping_options: { findFirst: jest.Mock };
}

describe('OrderService — branches', () => {
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
      getNextOrderNumber: jest.fn().mockResolvedValue('ORD-2026-00001'),
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
      catalog_variants: { update: jest.fn(), updateMany: jest.fn() },
      shipments: { create: jest.fn() },
      shipping_options: { findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: OrderRepository, useValue: mockRepository },
        {
          provide: CouponService,
          useValue: { validateAndComputeDiscount: jest.fn(), redeem: jest.fn() },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(OrderService);
    repository = module.get(OrderRepository);
    couponService = module.get(CouponService);
    eventEmitter = module.get(EventEmitter2);
  });

  /** Drive createOrder and hand back the payload the repository was given. */
  async function created(
    dtoOverrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    repository.createOrder.mockResolvedValue(createMockOrder() as never);
    await service.createOrder(BUSINESS_ID, {
      clientId: CLIENT_ID,
      items: [{ itemId: ITEM_ID, quantity: 2 }],
      paymentMethod: PaymentMethod.COD,
      ...dtoOverrides,
    } as Parameters<OrderService['createOrder']>[1]);
    return repository.createOrder.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
  }

  // ───────────────────────────────────────────────────────────────────
  // Variant resolution
  // ───────────────────────────────────────────────────────────────────

  describe('createOrder — variants', () => {
    it('prefers the variant price, SKU and composed name', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ variants: [createMockVariant()] }),
      ]);

      const payload = await created({
        items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 1 }],
      });

      const lines = payload['lineItems'] as OrderLineItem[];
      expect(lines[0]).toMatchObject({
        variantId: VARIANT_ID,
        name: 'Test Product - Large',
        sku: 'TEST-001-L',
        unitPrice: 60000,
        totalPrice: 60000,
      });
    });

    it('falls back to the item price when the variant carries none', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({
          variants: [createMockVariant({ price: null, sku: null })],
        }),
      ]);

      const payload = await created({
        items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 1 }],
      });

      const lines = payload['lineItems'] as OrderLineItem[];
      expect(lines[0]?.unitPrice).toBe(50000);
      expect(lines[0]?.sku).toBe('TEST-001');
    });

    it('rejects a variant id that is not on the item', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ variants: [] }),
      ]);

      await expect(
        service.createOrder(BUSINESS_ID, {
          clientId: CLIENT_ID,
          items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 1 }],
          paymentMethod: PaymentMethod.COD,
        } as Parameters<OrderService['createOrder']>[1]),
      ).rejects.toThrow(/Variant not found or inactive/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Inventory guards
  // ───────────────────────────────────────────────────────────────────

  describe('createOrder — stock reservation', () => {
    it('decrements variant stock when the variant tracks a quantity', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ variants: [createMockVariant()] }),
      ]);

      await created({ items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 3 }] });

      expect(prisma.catalog_variants.update).toHaveBeenCalledWith({
        where: { id: VARIANT_ID, business_id: BUSINESS_ID },
        data: { stock_quantity: { decrement: 3 } },
      });
    });

    it('rejects an oversell on a variant', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({
          variants: [createMockVariant({ stock_quantity: 1 })],
        }),
      ]);

      await expect(
        service.createOrder(BUSINESS_ID, {
          clientId: CLIENT_ID,
          items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 5 }],
          paymentMethod: PaymentMethod.COD,
        } as Parameters<OrderService['createOrder']>[1]),
      ).rejects.toThrow(/Insufficient stock for variant/);
    });

    it('allows a variant oversell when the item permits backorder', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({
          allow_backorder: true,
          variants: [createMockVariant({ stock_quantity: 1 })],
        }),
      ]);

      await created({ items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 5 }] });

      expect(prisma.catalog_variants.update).toHaveBeenCalled();
    });

    it('skips reservation for a variant with untracked stock', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({
          variants: [createMockVariant({ stock_quantity: null })],
        }),
      ]);

      await created({ items: [{ itemId: ITEM_ID, variantId: VARIANT_ID, quantity: 5 }] });

      expect(prisma.catalog_variants.update).not.toHaveBeenCalled();
    });

    it('allows an item oversell when backorder is permitted', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ stock_quantity: 1, allow_backorder: true }),
      ]);

      await created({ items: [{ itemId: ITEM_ID, quantity: 5 }] });

      expect(prisma.catalog_items.update).toHaveBeenCalledWith({
        where: { id: ITEM_ID, business_id: BUSINESS_ID },
        data: { stock_quantity: { decrement: 5 } },
      });
    });

    it('skips reservation for an item with untracked stock', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ stock_quantity: null }),
      ]);

      await created();

      expect(prisma.catalog_items.update).not.toHaveBeenCalled();
    });

    it('skips reservation entirely when the item does not track inventory', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ track_inventory: false, stock_quantity: 0 }),
      ]);

      await created({ items: [{ itemId: ITEM_ID, quantity: 999 }] });

      expect(prisma.catalog_items.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Tax
  // ───────────────────────────────────────────────────────────────────

  describe('createOrder — tax', () => {
    it('extracts the tax component from a tax-inclusive price', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ tax_inclusive: true }),
      ]);

      const payload = await created({ items: [{ itemId: ITEM_ID, quantity: 1 }] });

      // ₹500 inclusive of 18% → tax = 500 - 500/1.18 = ₹76.27
      expect(payload['taxAmount']).toBe(76.27);
      expect(payload['subtotal']).toBe(500);
      expect(payload['total']).toBe(576.27);
    });

    it('scales tax down in proportion to a discount', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([createMockCatalogItem()]);
      couponService.validateAndComputeDiscount.mockResolvedValue({
        discountPaise: 50000,
        code: 'HALF',
        type: 'PERCENTAGE',
        value: 50,
        couponId: 'coupon-1',
      } as never);

      const payload = await created({ discountCode: 'HALF' });

      // Subtotal ₹1000, tax ₹180. Half off → tax halves to ₹90.
      expect(payload['discountAmount']).toBe(500);
      expect(payload['taxAmount']).toBe(90);
      expect(payload['total']).toBe(590);
      expect(couponService.redeem).toHaveBeenCalledWith(BUSINESS_ID, 'coupon-1');
    });

    it('charges no tax on a zero-value order', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([
        createMockCatalogItem({ price: 0, track_inventory: false }),
      ]);

      const payload = await created({ items: [{ itemId: ITEM_ID, quantity: 1 }] });

      expect(payload['subtotal']).toBe(0);
      expect(payload['taxAmount']).toBe(0);
      expect(payload['total']).toBe(0);
    });

    it('does not redeem a coupon when none was applied', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([createMockCatalogItem()]);

      await created();

      expect(couponService.redeem).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Shipping fee resolution
  // ───────────────────────────────────────────────────────────────────

  describe('createOrder — shipping fee', () => {
    it('rejects an unknown or inactive shipping option', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([createMockCatalogItem()]);
      prisma.shipping_options.findFirst.mockResolvedValue(null);

      await expect(
        service.createOrder(BUSINESS_ID, {
          clientId: CLIENT_ID,
          items: [{ itemId: ITEM_ID, quantity: 1 }],
          paymentMethod: PaymentMethod.COD,
          shippingOptionId: SHIPPING_OPTION_ID,
        } as Parameters<OrderService['createOrder']>[1]),
      ).rejects.toThrow(/Shipping option not found or inactive/);
    });

    it('charges the base fee when the option has no free-shipping threshold', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([createMockCatalogItem()]);
      prisma.shipping_options.findFirst.mockResolvedValue({
        id: SHIPPING_OPTION_ID,
        base_fee: 49.0,
        min_order_value_for_free: null,
      });

      const payload = await created({ shippingOptionId: SHIPPING_OPTION_ID });

      expect(payload['shippingFee']).toBe(49);
      expect(payload['total']).toBe(1229);
    });

    it('charges the base fee below the free-shipping threshold', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([createMockCatalogItem()]);
      prisma.shipping_options.findFirst.mockResolvedValue({
        id: SHIPPING_OPTION_ID,
        base_fee: 49.0,
        min_order_value_for_free: 5000.0,
      });

      const payload = await created({ shippingOptionId: SHIPPING_OPTION_ID });

      expect(payload['shippingFee']).toBe(49);
    });

    it('does not query shipping options when none is chosen', async () => {
      prisma.catalog_items.findMany.mockResolvedValue([createMockCatalogItem()]);

      const payload = await created();

      expect(prisma.shipping_options.findFirst).not.toHaveBeenCalled();
      expect(payload['shippingFee']).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cancellation + stock restoration
  // ───────────────────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('refuses to cancel an already REFUNDED order', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.REFUNDED }) as never,
      );

      await expect(
        service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'nope' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for an unknown order', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await expect(
        service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'nope' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('defaults cancelledBy to BUSINESS', async () => {
      repository.findOrderById.mockResolvedValue(createMockOrder() as never);
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );

      await service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'changed mind' });

      const [, event] = eventEmitter.emit.mock.calls.find(
        ([name]) => name === 'order.cancelled',
      )!;
      expect(event).toMatchObject({ cancelledBy: 'BUSINESS' });
    });

    it('honours an explicit cancelledBy', async () => {
      repository.findOrderById.mockResolvedValue(createMockOrder() as never);
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );

      await service.cancelOrder(BUSINESS_ID, ORDER_ID, {
        reason: 'changed mind',
        cancelledBy: 'CUSTOMER',
      } as Parameters<OrderService['cancelOrder']>[2]);

      const [, event] = eventEmitter.emit.mock.calls.find(
        ([name]) => name === 'order.cancelled',
      )!;
      expect(event).toMatchObject({ cancelledBy: 'CUSTOMER' });
    });

    it('restores variant stock through catalog_variants, not catalog_items', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({
          line_items: [{ ...MOCK_LINE_ITEMS[0], variantId: VARIANT_ID, quantity: 4 }],
        }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.CANCELLED }) as never,
      );

      await service.cancelOrder(BUSINESS_ID, ORDER_ID, { reason: 'wrong size' });

      expect(prisma.catalog_variants.updateMany).toHaveBeenCalledWith({
        where: { id: VARIANT_ID, business_id: BUSINESS_ID },
        data: { stock_quantity: { increment: 4 } },
      });
      expect(prisma.catalog_items.updateMany).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Retrieval + mapping
  // ───────────────────────────────────────────────────────────────────

  describe('listOrders', () => {
    it('parses the date filters when supplied', async () => {
      repository.findOrders.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await service.listOrders(BUSINESS_ID, {
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-02-01T00:00:00.000Z',
      } as Parameters<OrderService['listOrders']>[1]);

      expect(repository.findOrders).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          dateFrom: new Date('2026-01-01T00:00:00.000Z'),
          dateTo: new Date('2026-02-01T00:00:00.000Z'),
        }),
      );
    });

    it('leaves the date filters undefined when absent', async () => {
      repository.findOrders.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await service.listOrders(
        BUSINESS_ID,
        {} as Parameters<OrderService['listOrders']>[1],
      );

      expect(repository.findOrders).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ dateFrom: undefined, dateTo: undefined }),
      );
    });
  });

  describe('order DTO mapping', () => {
    it('nulls the optional lifecycle timestamps that are unset', async () => {
      repository.findOrderById.mockResolvedValue(createMockOrder() as never);

      const dto = await service.getOrder(BUSINESS_ID, ORDER_ID);

      expect(dto.confirmedAt).toBeNull();
      expect(dto.deliveredAt).toBeNull();
      expect(dto.cancelledAt).toBeNull();
      expect(dto.returnedAt).toBeNull();
    });

    it('serialises the lifecycle timestamps that are set', async () => {
      const stamp = new Date('2026-07-01T09:00:00Z');
      repository.findOrderById.mockResolvedValue(
        createMockOrder({
          confirmed_at: stamp,
          delivered_at: stamp,
          cancelled_at: stamp,
          returned_at: stamp,
        }) as never,
      );

      const dto = await service.getOrder(BUSINESS_ID, ORDER_ID);

      expect(dto.confirmedAt).toBe('2026-07-01T09:00:00.000Z');
      expect(dto.deliveredAt).toBe('2026-07-01T09:00:00.000Z');
      expect(dto.cancelledAt).toBe('2026-07-01T09:00:00.000Z');
      expect(dto.returnedAt).toBe('2026-07-01T09:00:00.000Z');
    });
  });

  describe('getRecentOrdersForClient', () => {
    it('defaults to five orders', async () => {
      repository.findRecentOrdersForClient.mockResolvedValue([]);

      await service.getRecentOrdersForClient(BUSINESS_ID, CLIENT_ID);

      expect(repository.findRecentOrdersForClient).toHaveBeenCalledWith(
        BUSINESS_ID,
        CLIENT_ID,
        5,
      );
    });
  });

  describe('getOrderStatusForClient', () => {
    beforeEach(() => {
      repository.findRecentOrdersForClient.mockResolvedValue([]);
      repository.countOrdersForClient.mockResolvedValue(0);
    });

    it('omits the detail block when the requested order does not exist', async () => {
      repository.findOrderById.mockResolvedValue(null);

      const summary = await service.getOrderStatusForClient(
        BUSINESS_ID,
        CLIENT_ID,
        ORDER_ID,
      );

      expect(summary.order).toBeUndefined();
    });

    it('omits the detail block when the order belongs to another client', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ client_id: 'someone-else' }) as never,
      );

      const summary = await service.getOrderStatusForClient(
        BUSINESS_ID,
        CLIENT_ID,
        ORDER_ID,
      );

      expect(summary.order).toBeUndefined();
    });

    it('leaves tracking fields undefined when the order has no shipment', async () => {
      repository.findOrderById.mockResolvedValue(createMockOrder() as never);

      const summary = await service.getOrderStatusForClient(
        BUSINESS_ID,
        CLIENT_ID,
        ORDER_ID,
      );

      expect(summary.order).toBeDefined();
      expect(summary.order?.trackingNumber).toBeUndefined();
      expect(summary.order?.estimatedDeliveryAt).toBeUndefined();
    });

    it('surfaces tracking details from the latest shipment', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({
          shipments: [
            {
              tracking_number: 'TRK-1',
              tracking_url: 'https://track/1',
              estimated_delivery_at: new Date('2026-07-05T00:00:00Z'),
            },
          ],
        }) as never,
      );

      const summary = await service.getOrderStatusForClient(
        BUSINESS_ID,
        CLIENT_ID,
        ORDER_ID,
      );

      expect(summary.order).toMatchObject({
        trackingNumber: 'TRK-1',
        trackingUrl: 'https://track/1',
        estimatedDeliveryAt: '2026-07-05T00:00:00.000Z',
      });
    });

    it('tolerates a shipment row with no estimated delivery date', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ shipments: [{ tracking_number: 'TRK-2' }] }) as never,
      );

      const summary = await service.getOrderStatusForClient(
        BUSINESS_ID,
        CLIENT_ID,
        ORDER_ID,
      );

      expect(summary.order?.trackingNumber).toBe('TRK-2');
      expect(summary.order?.estimatedDeliveryAt).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Event handlers
  // ───────────────────────────────────────────────────────────────────

  describe('event handlers', () => {
    const paymentEvent = {
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      paymentId: 'pay-1',
      correlationId: 'corr-1',
    } as PaymentSuccessEvent;

    const refundEvent = {
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      refundId: 'ref-1',
    } as PaymentRefundEvent;

    it('ignores payment success for an order that no longer exists', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await service.handlePaymentSuccess(paymentEvent);

      expect(repository.updateOrderStatus).not.toHaveBeenCalled();
    });

    it('swallows a repository failure on payment success', async () => {
      repository.findOrderById.mockRejectedValue(new Error('db down'));

      await expect(
        service.handlePaymentSuccess(paymentEvent),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error rejection on payment success', async () => {
      repository.findOrderById.mockRejectedValue('db down');

      await expect(
        service.handlePaymentSuccess(paymentEvent),
      ).resolves.toBeUndefined();
    });

    it('ignores a refund event with no orderId', async () => {
      await service.handleRefundCompleted({
        ...refundEvent,
        orderId: undefined,
      } as PaymentRefundEvent);

      expect(repository.findOrderById).not.toHaveBeenCalled();
    });

    it('ignores a refund for an order that no longer exists', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await service.handleRefundCompleted(refundEvent);

      expect(repository.updateOrderStatus).not.toHaveBeenCalled();
    });

    it('swallows a repository failure on refund completion', async () => {
      repository.findOrderById.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleRefundCompleted(refundEvent),
      ).resolves.toBeUndefined();
    });

    it('ignores a delivery event with no orderId', async () => {
      await service.handleShippingDelivered({ businessId: BUSINESS_ID, orderId: '' });

      expect(repository.findOrderById).not.toHaveBeenCalled();
    });

    it('ignores a delivery for an order that no longer exists', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await service.handleShippingDelivered({
        businessId: BUSINESS_ID,
        orderId: ORDER_ID,
      });

      expect(repository.updateOrderStatus).not.toHaveBeenCalled();
    });

    it('honours the delivery timestamp and correlation id from the event', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DELIVERED }) as never,
      );

      await service.handleShippingDelivered({
        businessId: BUSINESS_ID,
        orderId: ORDER_ID,
        deliveredAt: '2026-07-04T12:00:00.000Z',
        correlationId: 'corr-shipping',
      });

      expect(repository.updateOrderStatus).toHaveBeenCalledWith(
        BUSINESS_ID,
        ORDER_ID,
        OrderStatus.DELIVERED,
        { deliveredAt: new Date('2026-07-04T12:00:00.000Z') },
      );
      const [, event] = eventEmitter.emit.mock.calls.find(
        ([name]) => name === 'order.delivered',
      )!;
      expect(event).toMatchObject({
        correlationId: 'corr-shipping',
        deliveredAt: '2026-07-04T12:00:00.000Z',
      });
    });

    it('generates a correlation id when the delivery event omits one', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DELIVERED }) as never,
      );

      await service.handleShippingDelivered({
        businessId: BUSINESS_ID,
        orderId: ORDER_ID,
      });

      const [, event] = eventEmitter.emit.mock.calls.find(
        ([name]) => name === 'order.delivered',
      )!;
      expect((event as { correlationId: string }).correlationId).toEqual(
        expect.any(String),
      );
    });

    it('swallows a repository failure on shipping delivery', async () => {
      repository.findOrderById.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleShippingDelivered({
          businessId: BUSINESS_ID,
          orderId: ORDER_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // State machine
  // ───────────────────────────────────────────────────────────────────

  describe('validateTransition', () => {
    it('reports the terminal statuses as having no onward transitions', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.REFUNDED }) as never,
      );

      await expect(
        service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
          status: OrderStatus.CONFIRMED,
        }),
      ).rejects.toThrow(/Allowed transitions from REFUNDED: none/);
    });

    it('rejects a status that is not in the transition table at all', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: 'BOGUS' }) as never,
      );

      await expect(
        service.updateOrderStatus(BUSINESS_ID, ORDER_ID, {
          status: OrderStatus.CONFIRMED,
        }),
      ).rejects.toThrow(/Allowed transitions from BOGUS: none/);
    });

    it('rejects packing an order that was never processed', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.DRAFT }) as never,
      );

      await expect(
        service.markPacked(BUSINESS_ID, ORDER_ID, {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException from markPacked for an unknown order', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await expect(
        service.markPacked(BUSINESS_ID, ORDER_ID, {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException from createShipment for an unknown order', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await expect(
        service.createShipment(BUSINESS_ID, ORDER_ID, {
          provider: 'DELHIVERY',
          trackingId: 'TRK-1',
        } as Parameters<OrderService['createShipment']>[2]),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException from returnOrder for an unknown order', async () => {
      repository.findOrderById.mockResolvedValue(null);

      await expect(
        service.returnOrder(BUSINESS_ID, ORDER_ID, { reason: 'damaged' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createShipment', () => {
    it('defaults the optional shipment fields to null', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PACKED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );

      await service.createShipment(BUSINESS_ID, ORDER_ID, {
        provider: 'DELHIVERY',
        trackingId: 'TRK-1',
      } as Parameters<OrderService['createShipment']>[2]);

      expect(prisma.shipments.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tracking_url: null,
          carrier: null,
          estimated_delivery_at: null,
        }),
      });
    });

    it('passes through the optional shipment fields when supplied', async () => {
      repository.findOrderById.mockResolvedValue(
        createMockOrder({ status: OrderStatus.PACKED }) as never,
      );
      repository.updateOrderStatus.mockResolvedValue(
        createMockOrder({ status: OrderStatus.SHIPPED }) as never,
      );

      await service.createShipment(BUSINESS_ID, ORDER_ID, {
        provider: 'DELHIVERY',
        trackingId: 'TRK-1',
        trackingUrl: 'https://track/1',
        carrier: 'BlueDart',
        estimatedDeliveryAt: '2026-07-05T00:00:00.000Z',
      } as Parameters<OrderService['createShipment']>[2]);

      expect(prisma.shipments.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tracking_url: 'https://track/1',
          carrier: 'BlueDart',
          estimated_delivery_at: new Date('2026-07-05T00:00:00.000Z'),
        }),
      });
    });
  });
});
