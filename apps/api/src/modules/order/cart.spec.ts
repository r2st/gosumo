import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartRepository } from './cart.repository';
import { CouponService } from './coupon.service';
import { OrderService } from './order.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CartStatus, DiscountType, PaymentMethod } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const CART_ID = '00000000-0000-4000-8000-000000000020';
const ITEM_ID = '00000000-0000-4000-8000-000000000004';
const CART_ITEM_ID = '00000000-0000-4000-8000-000000000021';
const COUPON_ID = '00000000-0000-4000-8000-000000000008';

function mockCartItem(overrides: Record<string, unknown> = {}) {
  return {
    id: CART_ITEM_ID,
    business_id: BUSINESS_ID,
    cart_id: CART_ID,
    item_id: ITEM_ID,
    variant_id: null,
    quantity: 2,
    unit_price: 500, // 500 INR
    metadata: { name: 'Test Product', sku: 'TEST-001' },
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    ...overrides,
  };
}

function mockCart(overrides: Record<string, unknown> = {}, items: unknown[] = []) {
  return {
    id: CART_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    status: CartStatus.ACTIVE,
    coupon_id: null,
    discount_code: null,
    discount_type: null,
    discount_value: null,
    converted_order_id: null,
    converted_at: null,
    metadata: {},
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    deleted_at: null,
    items,
    ...overrides,
  };
}

function mockCatalogItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    business_id: BUSINESS_ID,
    name: 'Test Product',
    price: 500,
    sku: 'TEST-001',
    is_active: true,
    deleted_at: null,
    variants: [],
    ...overrides,
  };
}

describe('CartService', () => {
  let service: CartService;
  let repository: jest.Mocked<CartRepository>;
  let couponService: jest.Mocked<CouponService>;
  let orderService: jest.Mocked<OrderService>;
  let prisma: { catalog_items: { findFirst: jest.Mock } };

  beforeEach(async () => {
    const mockRepository = {
      findActiveCart: jest.fn(),
      createCart: jest.fn(),
      findCartById: jest.fn(),
      findItemByProduct: jest.fn(),
      createItem: jest.fn(),
      findItem: jest.fn(),
      updateItemQuantity: jest.fn(),
      removeItem: jest.fn(),
      clearItems: jest.fn(),
      setCoupon: jest.fn(),
      clearCoupon: jest.fn(),
      markConverted: jest.fn(),
      touch: jest.fn(),
    };

    prisma = { catalog_items: { findFirst: jest.fn() } };

    const mockCouponService = {
      validateAndComputeDiscount: jest.fn(),
      redeem: jest.fn(),
    };

    const mockOrderService = { createOrder: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: CartRepository, useValue: mockRepository },
        { provide: PrismaService, useValue: prisma },
        { provide: CouponService, useValue: mockCouponService },
        { provide: OrderService, useValue: mockOrderService },
      ],
    }).compile();

    service = module.get<CartService>(CartService);
    repository = module.get(CartRepository) as jest.Mocked<CartRepository>;
    couponService = module.get(CouponService) as jest.Mocked<CouponService>;
    orderService = module.get(OrderService) as jest.Mocked<OrderService>;
  });

  describe('getOrCreateCart', () => {
    it('returns existing active cart', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      expect(result.id).toBe(CART_ID);
      expect(result.items).toHaveLength(1);
      expect(repository.createCart).not.toHaveBeenCalled();
    });

    it('creates a cart when none exists', async () => {
      repository.findActiveCart.mockResolvedValue(null);
      repository.createCart.mockResolvedValue(mockCart() as never);

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      expect(repository.createCart).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
      expect(result.items).toHaveLength(0);
    });

    it('computes subtotal and total in paise', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem({ quantity: 2, unit_price: 500 })]) as never,
      );

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      expect(result.subtotalPaise).toBe(100000); // 2 * 500 INR
      expect(result.totalPaise).toBe(100000);
      expect(result.itemCount).toBe(2);
    });
  });

  describe('addItem', () => {
    it('creates a new line with a price snapshot', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart() as never);
      prisma.catalog_items.findFirst.mockResolvedValue(mockCatalogItem());
      repository.findItemByProduct.mockResolvedValue(null);
      repository.createItem.mockResolvedValue(mockCartItem() as never);
      repository.findCartById.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );

      await service.addItem(BUSINESS_ID, CLIENT_ID, {
        itemId: ITEM_ID,
        quantity: 2,
      });

      expect(repository.createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          cartId: CART_ID,
          itemId: ITEM_ID,
          quantity: 2,
          unitPrice: 500,
        }),
      );
    });

    it('increments quantity on an existing line', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart() as never);
      prisma.catalog_items.findFirst.mockResolvedValue(mockCatalogItem());
      repository.findItemByProduct.mockResolvedValue(
        mockCartItem({ quantity: 1 }) as never,
      );
      repository.findCartById.mockResolvedValue(
        mockCart({}, [mockCartItem({ quantity: 4 })]) as never,
      );

      await service.addItem(BUSINESS_ID, CLIENT_ID, {
        itemId: ITEM_ID,
        quantity: 3,
      });

      expect(repository.updateItemQuantity).toHaveBeenCalledWith(CART_ITEM_ID, 4);
      expect(repository.createItem).not.toHaveBeenCalled();
    });

    it('throws when the catalog item is missing', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart() as never);
      prisma.catalog_items.findFirst.mockResolvedValue(null);

      await expect(
        service.addItem(BUSINESS_ID, CLIENT_ID, { itemId: ITEM_ID, quantity: 1 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateItem', () => {
    it('updates the quantity of an existing line', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );
      repository.findItem.mockResolvedValue(mockCartItem() as never);
      repository.findCartById.mockResolvedValue(
        mockCart({}, [mockCartItem({ quantity: 5 })]) as never,
      );

      await service.updateItem(BUSINESS_ID, CLIENT_ID, CART_ITEM_ID, {
        quantity: 5,
      });

      expect(repository.updateItemQuantity).toHaveBeenCalledWith(CART_ITEM_ID, 5);
    });

    it('throws NotFound for an unknown line', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart() as never);
      repository.findItem.mockResolvedValue(null);

      await expect(
        service.updateItem(BUSINESS_ID, CLIENT_ID, CART_ITEM_ID, { quantity: 5 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeItem', () => {
    it('removes an existing line', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );
      repository.findItem.mockResolvedValue(mockCartItem() as never);
      repository.findCartById.mockResolvedValue(mockCart() as never);

      await service.removeItem(BUSINESS_ID, CLIENT_ID, CART_ITEM_ID);

      expect(repository.removeItem).toHaveBeenCalledWith(CART_ITEM_ID);
    });
  });

  describe('applyCoupon', () => {
    it('validates and stores the coupon', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );
      couponService.validateAndComputeDiscount.mockResolvedValue({
        couponId: COUPON_ID,
        code: 'DIWALI20',
        type: DiscountType.PERCENT,
        value: 20,
        discountPaise: 20000,
      });
      repository.findCartById.mockResolvedValue(
        mockCart(
          {
            discount_code: 'DIWALI20',
            discount_type: DiscountType.PERCENT,
            discount_value: 20,
          },
          [mockCartItem()],
        ) as never,
      );

      const result = await service.applyCoupon(BUSINESS_ID, CLIENT_ID, {
        code: 'DIWALI20',
      });

      expect(repository.setCoupon).toHaveBeenCalledWith(
        CART_ID,
        expect.objectContaining({ code: 'DIWALI20', couponId: COUPON_ID }),
      );
      // 20% of 100000 paise subtotal
      expect(result.discountPaise).toBe(20000);
      expect(result.totalPaise).toBe(80000);
    });

    it('rejects applying a coupon to an empty cart', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart({}, []) as never);

      await expect(
        service.applyCoupon(BUSINESS_ID, CLIENT_ID, { code: 'DIWALI20' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('checkout', () => {
    it('converts the cart to an order', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({ discount_code: 'DIWALI20' }, [mockCartItem()]) as never,
      );
      orderService.createOrder.mockResolvedValue({
        id: 'order-id',
        orderNumber: 'ORD-2026-00001',
      } as never);

      const result = await service.checkout(BUSINESS_ID, CLIENT_ID, {
        paymentMethod: PaymentMethod.COD,
      });

      expect(orderService.createOrder).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          clientId: CLIENT_ID,
          discountCode: 'DIWALI20',
          items: [expect.objectContaining({ itemId: ITEM_ID, quantity: 2 })],
        }),
      );
      expect(repository.markConverted).toHaveBeenCalledWith(CART_ID, 'order-id');
      expect(result.orderNumber).toBe('ORD-2026-00001');
    });

    it('rejects checkout of an empty cart', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart({}, []) as never);

      await expect(
        service.checkout(BUSINESS_ID, CLIENT_ID, {
          paymentMethod: PaymentMethod.COD,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(orderService.createOrder).not.toHaveBeenCalled();
    });
  });
});
