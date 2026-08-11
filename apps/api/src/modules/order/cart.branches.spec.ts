import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartRepository } from './cart.repository';
import { CouponService } from './coupon.service';
import { OrderService } from './order.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CartStatus, DiscountType } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const CART_ID = '00000000-0000-4000-8000-000000000020';
const ITEM_ID = '00000000-0000-4000-8000-000000000004';
const CART_ITEM_ID = '00000000-0000-4000-8000-000000000021';
const VARIANT_ID = '00000000-0000-4000-8000-000000000030';

function mockCartItem(overrides: Record<string, unknown> = {}) {
  return {
    id: CART_ITEM_ID,
    business_id: BUSINESS_ID,
    cart_id: CART_ID,
    item_id: ITEM_ID,
    variant_id: null,
    quantity: 2,
    unit_price: 500,
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

describe('CartService — branch coverage', () => {
  let service: CartService;
  let repository: jest.Mocked<CartRepository>;
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: CartRepository, useValue: mockRepository },
        { provide: PrismaService, useValue: prisma },
        {
          provide: CouponService,
          useValue: { validateAndComputeDiscount: jest.fn(), redeem: jest.fn() },
        },
        { provide: OrderService, useValue: { createOrder: jest.fn() } },
      ],
    }).compile();

    service = module.get<CartService>(CartService);
    repository = module.get(CartRepository) as jest.Mocked<CartRepository>;
  });

  describe('removeItem', () => {
    it('throws NotFound when the line does not belong to the cart', async () => {
      repository.findActiveCart.mockResolvedValue(mockCart() as never);
      repository.findItem.mockResolvedValue(null);

      await expect(
        service.removeItem(BUSINESS_ID, CLIENT_ID, CART_ITEM_ID),
      ).rejects.toThrow(NotFoundException);
      expect(repository.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('clearCart', () => {
    it('drops every line and the attached coupon', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({ discount_code: 'DIWALI20' }, [mockCartItem()]) as never,
      );
      repository.findCartById.mockResolvedValue(mockCart({}, []) as never);

      const result = await service.clearCart(BUSINESS_ID, CLIENT_ID);

      expect(repository.clearItems).toHaveBeenCalledWith(BUSINESS_ID, CART_ID);
      expect(repository.clearCoupon).toHaveBeenCalledWith(BUSINESS_ID, CART_ID);
      expect(repository.touch).toHaveBeenCalledWith(BUSINESS_ID, CART_ID);
      expect(result.items).toHaveLength(0);
      expect(result.totalPaise).toBe(0);
    });

    it('creates an empty cart first when the client has none', async () => {
      repository.findActiveCart.mockResolvedValue(null);
      repository.createCart.mockResolvedValue(mockCart() as never);
      repository.findCartById.mockResolvedValue(mockCart() as never);

      await service.clearCart(BUSINESS_ID, CLIENT_ID);

      expect(repository.createCart).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
    });
  });

  describe('removeCoupon', () => {
    it('clears the coupon and returns the undiscounted cart', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart(
          {
            discount_code: 'DIWALI20',
            discount_type: DiscountType.PERCENT,
            discount_value: 20,
          },
          [mockCartItem()],
        ) as never,
      );
      repository.findCartById.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );

      const result = await service.removeCoupon(BUSINESS_ID, CLIENT_ID);

      expect(repository.clearCoupon).toHaveBeenCalledWith(BUSINESS_ID, CART_ID);
      expect(result.discountPaise).toBe(0);
      expect(result.discountCode).toBeNull();
      expect(result.totalPaise).toBe(result.subtotalPaise);
    });
  });

  describe('getReloadedCart', () => {
    it('throws NotFound when the cart vanishes between write and reload', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem()]) as never,
      );
      repository.findItem.mockResolvedValue(mockCartItem() as never);
      repository.findCartById.mockResolvedValue(null);

      await expect(
        service.removeItem(BUSINESS_ID, CLIENT_ID, CART_ITEM_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolveProduct — variants', () => {
    const catalogWithVariant = (variant: Record<string, unknown>) => ({
      id: ITEM_ID,
      business_id: BUSINESS_ID,
      name: 'Kurta',
      price: 900,
      sku: 'KUR-001',
      is_active: true,
      deleted_at: null,
      variants: [variant],
    });

    beforeEach(() => {
      repository.findActiveCart.mockResolvedValue(mockCart() as never);
      repository.findItemByProduct.mockResolvedValue(null);
      repository.createItem.mockResolvedValue(mockCartItem() as never);
      repository.findCartById.mockResolvedValue(mockCart() as never);
    });

    it('uses the variant price and composed name when the variant is priced', async () => {
      prisma.catalog_items.findFirst.mockResolvedValue(
        catalogWithVariant({
          id: VARIANT_ID,
          name: 'Large',
          price: 1200,
          sku: 'KUR-001-L',
        }),
      );

      await service.addItem(BUSINESS_ID, CLIENT_ID, {
        itemId: ITEM_ID,
        variantId: VARIANT_ID,
        quantity: 1,
      });

      expect(repository.createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          variantId: VARIANT_ID,
          unitPrice: 1200,
          metadata: { name: 'Kurta - Large', sku: 'KUR-001-L' },
        }),
      );
    });

    it('falls back to the parent price and SKU when the variant carries neither', async () => {
      prisma.catalog_items.findFirst.mockResolvedValue(
        catalogWithVariant({
          id: VARIANT_ID,
          name: 'Small',
          price: null,
          sku: null,
        }),
      );

      await service.addItem(BUSINESS_ID, CLIENT_ID, {
        itemId: ITEM_ID,
        variantId: VARIANT_ID,
        quantity: 1,
      });

      expect(repository.createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          unitPrice: 900,
          metadata: { name: 'Kurta - Small', sku: 'KUR-001' },
        }),
      );
    });

    it('rejects a variant that is inactive or belongs to another item', async () => {
      prisma.catalog_items.findFirst.mockResolvedValue(
        catalogWithVariant({
          id: '00000000-0000-4000-8000-0000000000ff',
          name: 'Other',
          price: 100,
          sku: 'OTH',
        }),
      );

      await expect(
        service.addItem(BUSINESS_ID, CLIENT_ID, {
          itemId: ITEM_ID,
          variantId: VARIANT_ID,
          quantity: 1,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.createItem).not.toHaveBeenCalled();
    });

    it('scopes the catalog lookup to the tenant and active rows', async () => {
      prisma.catalog_items.findFirst.mockResolvedValue(
        catalogWithVariant({
          id: VARIANT_ID,
          name: 'Large',
          price: 1200,
          sku: 'KUR-001-L',
        }),
      );

      await service.addItem(BUSINESS_ID, CLIENT_ID, {
        itemId: ITEM_ID,
        variantId: VARIANT_ID,
        quantity: 1,
      });

      expect(prisma.catalog_items.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: ITEM_ID,
            business_id: BUSINESS_ID,
            is_active: true,
            deleted_at: null,
          },
        }),
      );
    });
  });

  describe('display discount', () => {
    it('converts a FIXED discount from rupees to paise', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart(
          {
            discount_code: 'FLAT100',
            discount_type: DiscountType.FIXED,
            discount_value: 100,
          },
          [mockCartItem({ quantity: 2, unit_price: 500 })],
        ) as never,
      );

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      expect(result.subtotalPaise).toBe(100000);
      expect(result.discountPaise).toBe(10000);
      expect(result.totalPaise).toBe(90000);
    });

    it('caps the discount at the subtotal so the total never goes negative', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart(
          {
            discount_code: 'FLAT9999',
            discount_type: DiscountType.FIXED,
            discount_value: 9999,
          },
          [mockCartItem({ quantity: 1, unit_price: 100 })],
        ) as never,
      );

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      expect(result.discountPaise).toBe(10000);
      expect(result.totalPaise).toBe(0);
    });

    it('treats a type without a value as no discount', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart(
          { discount_type: DiscountType.PERCENT, discount_value: null },
          [mockCartItem()],
        ) as never,
      );

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      expect(result.discountPaise).toBe(0);
    });

    it('defaults the display name and SKU when the line metadata is empty', async () => {
      repository.findActiveCart.mockResolvedValue(
        mockCart({}, [mockCartItem({ metadata: null })]) as never,
      );

      const result = await service.getOrCreateCart(BUSINESS_ID, CLIENT_ID);

      const [line] = result.items;
      expect(line?.name).toBe('Item');
      expect(line?.sku).toBeNull();
    });
  });
});
