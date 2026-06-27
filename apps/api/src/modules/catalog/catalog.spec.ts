/**
 * Catalog module unit tests
 *
 * Coverage:
 *  1. Categories — create (auto-slug, explicit slug, parent validation),
 *     get, update (self-parent guard, parent validation), delete
 *     (active-item guard), list (nested children)
 *  2. Items — create (auto SKU + slug + ai_description, conflict guards,
 *     category validation, event emission), get, update (change tracking +
 *     event), soft delete, list (pagination + tag split), search
 *  3. Variants — add (SKU conflict guards, null-price inherit), update
 *     (ownership + SKU), delete, list
 *  4. Pricing — effective price (item base, variant override, variant
 *     inherit, quantity total, not-found paths)
 *  5. Stock — update (item/variant, no-op when untracked, low-stock and
 *     stock-out events), get stock level (tracked/untracked/flags)
 *  6. Event listeners — order.created decrements stock, order.cancelled
 *     restocks, error resilience
 *  7. Multi-tenant scoping — businessId threaded into every repository call
 *
 * The repository and EventEmitter2 are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CatalogItemType } from '@gosumo/shared';
import type { OrderCreatedEvent } from '@gosumo/shared';

import { CatalogService } from './catalog.service';
import { CatalogRepository } from './catalog.repository';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-0000000000ff';
const CATEGORY_ID = '00000000-0000-4000-a000-000000000010';
const PARENT_CATEGORY_ID = '00000000-0000-4000-a000-000000000011';
const ITEM_ID = '00000000-0000-4000-a000-000000000020';
const VARIANT_ID = '00000000-0000-4000-a000-000000000030';
const OTHER_VARIANT_ID = '00000000-0000-4000-a000-000000000031';
const ORDER_ID = '00000000-0000-4000-a000-000000000040';
const CLIENT_ID = '00000000-0000-4000-a000-0000000000aa';

// ─────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────

function makeCategory(overrides: Record<string, unknown> = {}) {
  return {
    id: CATEGORY_ID,
    business_id: BUSINESS_ID,
    parent_id: null,
    name: 'Electronics',
    slug: 'electronics',
    description: 'Electronic items',
    image_url: null,
    sort_order: 0,
    is_active: true,
    metadata: {},
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    deleted_at: null,
    children: [],
    ...overrides,
  };
}

function makeVariant(overrides: Record<string, unknown> = {}) {
  return {
    id: VARIANT_ID,
    business_id: BUSINESS_ID,
    item_id: ITEM_ID,
    name: 'Black / Large',
    sku: 'VAR-BLK-L',
    barcode: null,
    price: null as Prisma.Decimal | null,
    compare_price: null as Prisma.Decimal | null,
    attributes: { color: 'black', size: 'large' },
    stock_quantity: 20,
    is_active: true,
    sort_order: 0,
    image_url: null,
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    business_id: BUSINESS_ID,
    category_id: CATEGORY_ID,
    type: 'PRODUCT',
    name: 'Wireless Mouse',
    slug: 'wireless-mouse',
    description: 'A high-quality wireless mouse',
    short_description: 'Wireless mouse',
    price: new Prisma.Decimal('499.00'), // → 49900 paise
    compare_price: new Prisma.Decimal('699.00'), // MRP → 69900 paise
    currency: 'INR',
    tax_rate: new Prisma.Decimal('0.18'),
    tax_inclusive: true,
    sku: 'ITM-ABC123',
    barcode: null,
    stock_quantity: 50,
    track_inventory: true,
    allow_backorder: false,
    low_stock_threshold: 10,
    weight_grams: 80,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    images: [{ url: 'https://cdn.test/mouse.jpg', alt: 'Mouse', isPrimary: true }],
    tags: ['electronics', 'mouse'],
    ai_description: 'Wireless Mouse. Wireless mouse. Tags: electronics, mouse',
    is_active: true,
    is_featured: false,
    sort_order: 0,
    metadata: {},
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    deleted_at: null,
    category: makeCategory(),
    variants: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────

describe('CatalogService', () => {
  let service: CatalogService;
  let repository: jest.Mocked<CatalogRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof CatalogRepository, jest.Mock>> = {
      createCategory: jest.fn(),
      findCategoryById: jest.fn(),
      updateCategory: jest.fn(),
      softDeleteCategory: jest.fn(),
      listCategories: jest.fn(),
      countActiveItemsInCategory: jest.fn(),
      createItem: jest.fn(),
      findItemById: jest.fn(),
      updateItem: jest.fn(),
      softDeleteItem: jest.fn(),
      listItems: jest.fn(),
      searchCatalog: jest.fn(),
      findItemBySku: jest.fn(),
      findItemBySlug: jest.fn(),
      updateItemStock: jest.fn(),
      createVariant: jest.fn(),
      findVariantById: jest.fn(),
      updateVariant: jest.fn(),
      softDeleteVariant: jest.fn(),
      listVariantsByItemId: jest.fn(),
      updateVariantStock: jest.fn(),
      findVariantBySku: jest.fn(),
    };

    const mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: CatalogRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<CatalogService>(CatalogService);
    repository = module.get(CatalogRepository) as jest.Mocked<CatalogRepository>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─────────────────────────────────────────────
  // CATEGORIES
  // ─────────────────────────────────────────────

  describe('createCategory', () => {
    it('auto-generates a slug from the name when none is provided', async () => {
      repository.createCategory.mockResolvedValue(
        makeCategory({ name: 'Home & Kitchen', slug: 'home-kitchen' }) as never,
      );

      const result = await service.createCategory(BUSINESS_ID, { name: 'Home & Kitchen' });

      expect(repository.createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, slug: 'home-kitchen' }),
      );
      expect(result.slug).toBe('home-kitchen');
    });

    it('uses the explicit slug when provided', async () => {
      repository.createCategory.mockResolvedValue(makeCategory({ slug: 'custom-slug' }) as never);

      await service.createCategory(BUSINESS_ID, { name: 'Electronics', slug: 'custom-slug' });

      expect(repository.createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'custom-slug' }),
      );
    });

    it('validates the parent category exists', async () => {
      repository.findCategoryById.mockResolvedValue(
        makeCategory({ id: PARENT_CATEGORY_ID }) as never,
      );
      repository.createCategory.mockResolvedValue(
        makeCategory({ parent_id: PARENT_CATEGORY_ID }) as never,
      );

      await service.createCategory(BUSINESS_ID, { name: 'Phones', parentId: PARENT_CATEGORY_ID });

      expect(repository.findCategoryById).toHaveBeenCalledWith(BUSINESS_ID, PARENT_CATEGORY_ID);
    });

    it('throws NotFound when the parent category is missing', async () => {
      repository.findCategoryById.mockResolvedValue(null);

      await expect(
        service.createCategory(BUSINESS_ID, { name: 'Phones', parentId: PARENT_CATEGORY_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.createCategory).not.toHaveBeenCalled();
    });
  });

  describe('getCategory', () => {
    it('returns the mapped category', async () => {
      repository.findCategoryById.mockResolvedValue(makeCategory() as never);

      const result = await service.getCategory(BUSINESS_ID, CATEGORY_ID);

      expect(result.id).toBe(CATEGORY_ID);
      expect(result.businessId).toBe(BUSINESS_ID);
      expect(repository.findCategoryById).toHaveBeenCalledWith(BUSINESS_ID, CATEGORY_ID);
    });

    it('throws NotFound when missing', async () => {
      repository.findCategoryById.mockResolvedValue(null);
      await expect(service.getCategory(BUSINESS_ID, CATEGORY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateCategory', () => {
    it('updates an existing category', async () => {
      repository.findCategoryById.mockResolvedValue(makeCategory() as never);
      repository.updateCategory.mockResolvedValue(makeCategory({ name: 'Renamed' }) as never);

      const result = await service.updateCategory(BUSINESS_ID, CATEGORY_ID, { name: 'Renamed' });

      expect(result.name).toBe('Renamed');
      expect(repository.updateCategory).toHaveBeenCalledWith(
        BUSINESS_ID,
        CATEGORY_ID,
        expect.objectContaining({ name: 'Renamed' }),
      );
    });

    it('throws NotFound when the category does not exist', async () => {
      repository.findCategoryById.mockResolvedValue(null);
      await expect(
        service.updateCategory(BUSINESS_ID, CATEGORY_ID, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a category being its own parent', async () => {
      repository.findCategoryById.mockResolvedValue(makeCategory() as never);

      await expect(
        service.updateCategory(BUSINESS_ID, CATEGORY_ID, { parentId: CATEGORY_ID }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('throws NotFound when the new parent is missing', async () => {
      repository.findCategoryById
        .mockResolvedValueOnce(makeCategory() as never) // the category itself
        .mockResolvedValueOnce(null); // the parent lookup

      await expect(
        service.updateCategory(BUSINESS_ID, CATEGORY_ID, { parentId: PARENT_CATEGORY_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteCategory', () => {
    it('soft-deletes a category with no active items', async () => {
      repository.findCategoryById.mockResolvedValue(makeCategory() as never);
      repository.countActiveItemsInCategory.mockResolvedValue(0);
      repository.softDeleteCategory.mockResolvedValue(makeCategory() as never);

      await service.deleteCategory(BUSINESS_ID, CATEGORY_ID);

      expect(repository.softDeleteCategory).toHaveBeenCalledWith(BUSINESS_ID, CATEGORY_ID);
    });

    it('throws 422 when the category still has active items', async () => {
      repository.findCategoryById.mockResolvedValue(makeCategory() as never);
      repository.countActiveItemsInCategory.mockResolvedValue(3);

      await expect(service.deleteCategory(BUSINESS_ID, CATEGORY_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repository.softDeleteCategory).not.toHaveBeenCalled();
    });

    it('throws NotFound when the category is missing', async () => {
      repository.findCategoryById.mockResolvedValue(null);
      await expect(service.deleteCategory(BUSINESS_ID, CATEGORY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listCategories', () => {
    it('returns mapped categories scoped to the business', async () => {
      repository.listCategories.mockResolvedValue([
        makeCategory(),
        makeCategory({ id: PARENT_CATEGORY_ID, slug: 'apparel' }),
      ] as never);

      const result = await service.listCategories(BUSINESS_ID, null);

      expect(result).toHaveLength(2);
      expect(repository.listCategories).toHaveBeenCalledWith(BUSINESS_ID, null);
    });

    it('maps nested children recursively', async () => {
      repository.listCategories.mockResolvedValue([
        makeCategory({
          children: [makeCategory({ id: PARENT_CATEGORY_ID, slug: 'child' })],
        }),
      ] as never);

      const result = await service.listCategories(BUSINESS_ID);

      expect(result[0]?.children).toHaveLength(1);
      expect(result[0]?.children?.[0]?.slug).toBe('child');
    });
  });

  // ─────────────────────────────────────────────
  // ITEMS
  // ─────────────────────────────────────────────

  describe('createItem', () => {
    it('auto-generates SKU, slug, and ai_description, then emits catalog.item.created', async () => {
      repository.findItemBySlug.mockResolvedValue(null);
      repository.findItemBySku.mockResolvedValue(null);
      repository.findCategoryById.mockResolvedValue(makeCategory() as never);
      repository.createItem.mockResolvedValue(makeItem() as never);

      const result = await service.createItem(BUSINESS_ID, {
        name: 'Wireless Mouse',
        pricePaise: 49900,
        categoryId: CATEGORY_ID,
        tags: ['electronics'],
      });

      expect(result.id).toBe(ITEM_ID);
      expect(result.pricePaise).toBe(49900);
      const createArg = repository.createItem.mock.calls[0]?.[0];
      expect(createArg?.businessId).toBe(BUSINESS_ID);
      expect(createArg?.slug).toBe('wireless-mouse');
      expect(createArg?.sku).toBeTruthy();
      expect(createArg?.aiDescription).toContain('Wireless Mouse');
      // 49900 paise → Decimal 499 rupees
      expect(createArg?.price.toString()).toBe('499');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'catalog.item.created',
        expect.objectContaining({
          type: 'catalog.item.created',
          itemId: ITEM_ID,
          businessId: BUSINESS_ID,
        }),
      );
    });

    it('defaults type to PRODUCT', async () => {
      repository.findItemBySlug.mockResolvedValue(null);
      repository.findItemBySku.mockResolvedValue(null);
      repository.createItem.mockResolvedValue(makeItem() as never);

      await service.createItem(BUSINESS_ID, { name: 'No Type Item', pricePaise: 1000 });

      expect(repository.createItem.mock.calls[0]?.[0].type).toBe(CatalogItemType.PRODUCT);
    });

    it('rejects a duplicate slug with 409', async () => {
      repository.findItemBySlug.mockResolvedValue(makeItem() as never);

      await expect(
        service.createItem(BUSINESS_ID, { name: 'Wireless Mouse', pricePaise: 49900 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.createItem).not.toHaveBeenCalled();
    });

    it('rejects a duplicate explicit SKU with 409', async () => {
      repository.findItemBySlug.mockResolvedValue(null);
      repository.findItemBySku.mockResolvedValue(makeItem() as never);

      await expect(
        service.createItem(BUSINESS_ID, {
          name: 'Wireless Mouse',
          pricePaise: 49900,
          sku: 'ITM-ABC123',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFound when the category is missing', async () => {
      repository.findItemBySlug.mockResolvedValue(null);
      repository.findItemBySku.mockResolvedValue(null);
      repository.findCategoryById.mockResolvedValue(null);

      await expect(
        service.createItem(BUSINESS_ID, {
          name: 'Wireless Mouse',
          pricePaise: 49900,
          categoryId: CATEGORY_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getItem', () => {
    it('returns the mapped item with paise conversion', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);

      const result = await service.getItem(BUSINESS_ID, ITEM_ID);

      expect(result.pricePaise).toBe(49900);
      expect(result.comparePricePaise).toBe(69900);
      expect(result.taxRate).toBeCloseTo(0.18);
      expect(repository.findItemById).toHaveBeenCalledWith(BUSINESS_ID, ITEM_ID);
    });

    it('throws NotFound when missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(service.getItem(BUSINESS_ID, ITEM_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateItem', () => {
    it('updates fields and emits catalog.item.updated with changedFields', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.updateItem.mockResolvedValue(makeItem({ name: 'New Name' }) as never);

      await service.updateItem(BUSINESS_ID, ITEM_ID, { name: 'New Name', pricePaise: 60000 });

      const updateArg = repository.updateItem.mock.calls[0]?.[2];
      expect(updateArg?.name).toBe('New Name');
      expect(updateArg?.price?.toString()).toBe('600');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'catalog.item.updated',
        expect.objectContaining({
          itemId: ITEM_ID,
          changedFields: expect.arrayContaining(['name', 'price']),
        }),
      );
    });

    it('does not emit an event when no fields change', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.updateItem.mockResolvedValue(makeItem() as never);

      await service.updateItem(BUSINESS_ID, ITEM_ID, {});

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('throws NotFound when the item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(
        service.updateItem(BUSINESS_ID, ITEM_ID, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a SKU collision with another item', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.findItemBySku.mockResolvedValue(makeItem({ id: 'another-item' }) as never);

      await expect(
        service.updateItem(BUSINESS_ID, ITEM_ID, { sku: 'TAKEN-SKU' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a slug collision with another item', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.findItemBySlug.mockResolvedValue(makeItem({ id: 'another-item' }) as never);

      await expect(
        service.updateItem(BUSINESS_ID, ITEM_ID, { slug: 'taken-slug' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deleteItem', () => {
    it('soft-deletes an item', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.softDeleteItem.mockResolvedValue(makeItem() as never);

      await service.deleteItem(BUSINESS_ID, ITEM_ID);

      expect(repository.softDeleteItem).toHaveBeenCalledWith(BUSINESS_ID, ITEM_ID);
    });

    it('throws NotFound when the item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(service.deleteItem(BUSINESS_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listItems', () => {
    it('passes pagination and splits comma-separated tags', async () => {
      repository.listItems.mockResolvedValue({
        data: [makeItem()],
        total: 1,
        page: 2,
        limit: 5,
        totalPages: 1,
      } as never);

      const result = await service.listItems(BUSINESS_ID, {
        page: 2,
        limit: 5,
        tags: 'electronics, mouse',
        search: 'mouse',
      });

      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      const filters = repository.listItems.mock.calls[0]?.[1];
      expect(filters?.tags).toEqual(['electronics', 'mouse']);
      expect(filters?.search).toBe('mouse');
      expect(repository.listItems.mock.calls[0]?.[0]).toBe(BUSINESS_ID);
    });
  });

  describe('searchCatalog', () => {
    it('returns mapped search results with the default limit', async () => {
      repository.searchCatalog.mockResolvedValue([makeItem()] as never);

      const result = await service.searchCatalog(BUSINESS_ID, 'mouse');

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Wireless Mouse');
      expect(repository.searchCatalog).toHaveBeenCalledWith(BUSINESS_ID, 'mouse', 10);
    });
  });

  // ─────────────────────────────────────────────
  // VARIANTS
  // ─────────────────────────────────────────────

  describe('addVariant', () => {
    it('creates a variant under an existing item', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.findVariantBySku.mockResolvedValue(null);
      repository.findItemBySku.mockResolvedValue(null);
      repository.createVariant.mockResolvedValue(makeVariant({ price: new Prisma.Decimal('550.00') }) as never);

      const result = await service.addVariant(BUSINESS_ID, ITEM_ID, {
        name: 'Black / Large',
        sku: 'VAR-BLK-L',
        pricePaise: 55000,
        attributes: { color: 'black', size: 'large' },
        stockQuantity: 20,
      });

      expect(result.id).toBe(VARIANT_ID);
      const arg = repository.createVariant.mock.calls[0]?.[0];
      expect(arg?.businessId).toBe(BUSINESS_ID);
      expect(arg?.itemId).toBe(ITEM_ID);
      expect(arg?.price?.toString()).toBe('550');
    });

    it('throws NotFound when the parent item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(
        service.addVariant(BUSINESS_ID, ITEM_ID, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a SKU already used by another variant', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.findVariantBySku.mockResolvedValue(makeVariant() as never);

      await expect(
        service.addVariant(BUSINESS_ID, ITEM_ID, { name: 'X', sku: 'DUP' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a SKU already used by an item', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.findVariantBySku.mockResolvedValue(null);
      repository.findItemBySku.mockResolvedValue(makeItem() as never);

      await expect(
        service.addVariant(BUSINESS_ID, ITEM_ID, { name: 'X', sku: 'DUP' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows a null price (inherit from parent)', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.createVariant.mockResolvedValue(makeVariant({ price: null }) as never);

      const result = await service.addVariant(BUSINESS_ID, ITEM_ID, { name: 'Inherit' });

      expect(repository.createVariant.mock.calls[0]?.[0].price).toBeNull();
      expect(result.pricePaise).toBeNull();
    });
  });

  describe('updateVariant', () => {
    it('updates a variant belonging to the item', async () => {
      repository.findVariantById.mockResolvedValue(makeVariant() as never);
      repository.updateVariant.mockResolvedValue(makeVariant({ name: 'Updated' }) as never);

      const result = await service.updateVariant(BUSINESS_ID, ITEM_ID, VARIANT_ID, {
        name: 'Updated',
      });

      expect(result.name).toBe('Updated');
    });

    it('throws NotFound when the variant belongs to a different item', async () => {
      repository.findVariantById.mockResolvedValue(
        makeVariant({ item_id: 'different-item' }) as never,
      );

      await expect(
        service.updateVariant(BUSINESS_ID, ITEM_ID, VARIANT_ID, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a SKU collision with another variant', async () => {
      repository.findVariantById.mockResolvedValue(makeVariant() as never);
      repository.findVariantBySku.mockResolvedValue(makeVariant({ id: OTHER_VARIANT_ID }) as never);

      await expect(
        service.updateVariant(BUSINESS_ID, ITEM_ID, VARIANT_ID, { sku: 'TAKEN' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deleteVariant', () => {
    it('soft-deletes a variant belonging to the item', async () => {
      repository.findVariantById.mockResolvedValue(makeVariant() as never);
      repository.softDeleteVariant.mockResolvedValue(makeVariant() as never);

      await service.deleteVariant(BUSINESS_ID, ITEM_ID, VARIANT_ID);

      expect(repository.softDeleteVariant).toHaveBeenCalledWith(BUSINESS_ID, VARIANT_ID);
    });

    it('throws NotFound when the variant belongs to a different item', async () => {
      repository.findVariantById.mockResolvedValue(
        makeVariant({ item_id: 'different-item-id' }) as never,
      );

      await expect(
        service.deleteVariant(BUSINESS_ID, ITEM_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listVariants', () => {
    it('returns mapped variants for an item', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);
      repository.listVariantsByItemId.mockResolvedValue([makeVariant()] as never);

      const result = await service.listVariants(BUSINESS_ID, ITEM_ID);

      expect(result).toHaveLength(1);
      expect(repository.listVariantsByItemId).toHaveBeenCalledWith(BUSINESS_ID, ITEM_ID);
    });

    it('throws NotFound when the item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(service.listVariants(BUSINESS_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────
  // PRICING
  // ─────────────────────────────────────────────

  describe('getEffectivePrice', () => {
    it('uses the item base price when no variant is given', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);

      const result = await service.getEffectivePrice(BUSINESS_ID, ITEM_ID, undefined, 3);

      expect(result.basePricePaise).toBe(49900);
      expect(result.finalPricePaise).toBe(49900);
      expect(result.quantity).toBe(3);
      expect(result.totalPaise).toBe(49900 * 3);
      expect(result.comparePricePaise).toBe(69900);
      expect(result.variantId).toBeNull();
    });

    it('uses the variant price override when present', async () => {
      repository.findItemById.mockResolvedValue(
        makeItem({ variants: [makeVariant({ price: new Prisma.Decimal('599.00') })] }) as never,
      );

      const result = await service.getEffectivePrice(BUSINESS_ID, ITEM_ID, VARIANT_ID, 1);

      expect(result.basePricePaise).toBe(59900);
      expect(result.variantId).toBe(VARIANT_ID);
    });

    it('inherits the item price when the variant price is null', async () => {
      repository.findItemById.mockResolvedValue(
        makeItem({ variants: [makeVariant({ price: null })] }) as never,
      );

      const result = await service.getEffectivePrice(BUSINESS_ID, ITEM_ID, VARIANT_ID);

      expect(result.basePricePaise).toBe(49900);
    });

    it('throws NotFound when the item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(service.getEffectivePrice(BUSINESS_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFound when the variant is missing', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ variants: [] }) as never);
      await expect(
        service.getEffectivePrice(BUSINESS_ID, ITEM_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // STOCK
  // ─────────────────────────────────────────────

  describe('updateStock', () => {
    it('decrements item stock and reports the new level', async () => {
      repository.findItemById
        .mockResolvedValueOnce(makeItem({ stock_quantity: 50 }) as never)
        .mockResolvedValueOnce(makeItem({ stock_quantity: 45 }) as never);
      repository.updateItemStock.mockResolvedValue(makeItem({ stock_quantity: 45 }) as never);

      const result = await service.updateStock(BUSINESS_ID, ITEM_ID, { delta: -5 });

      expect(repository.updateItemStock).toHaveBeenCalledWith(ITEM_ID, -5);
      expect(result.stockQuantity).toBe(45);
      expect(result.trackInventory).toBe(true);
      expect(result.isOutOfStock).toBe(false);
    });

    it('is a no-op when trackInventory is false', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ track_inventory: false }) as never);

      const result = await service.updateStock(BUSINESS_ID, ITEM_ID, { delta: -5 });

      expect(repository.updateItemStock).not.toHaveBeenCalled();
      expect(result.stockQuantity).toBeNull();
      expect(result.trackInventory).toBe(false);
    });

    it('emits catalog.stock.low when crossing the threshold', async () => {
      repository.findItemById
        .mockResolvedValueOnce(makeItem({ stock_quantity: 15, low_stock_threshold: 10 }) as never)
        .mockResolvedValueOnce(makeItem({ stock_quantity: 8, low_stock_threshold: 10 }) as never);
      repository.updateItemStock.mockResolvedValue(makeItem({ stock_quantity: 8 }) as never);

      await service.updateStock(BUSINESS_ID, ITEM_ID, { delta: -7 });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'catalog.stock.low',
        expect.objectContaining({ itemId: ITEM_ID, currentStock: 8, threshold: 10 }),
      );
    });

    it('emits catalog.stock.out when stock reaches zero', async () => {
      repository.findItemById
        .mockResolvedValueOnce(makeItem({ stock_quantity: 2 }) as never)
        .mockResolvedValueOnce(makeItem({ stock_quantity: 0 }) as never);
      repository.updateItemStock.mockResolvedValue(makeItem({ stock_quantity: 0 }) as never);

      await service.updateStock(BUSINESS_ID, ITEM_ID, { delta: -2 });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'catalog.stock.out',
        expect.objectContaining({ itemId: ITEM_ID }),
      );
    });

    it('updates variant stock when a variantId is supplied', async () => {
      repository.findItemById
        .mockResolvedValueOnce(
          makeItem({ variants: [makeVariant({ stock_quantity: 20 })] }) as never,
        )
        .mockResolvedValueOnce(
          makeItem({ variants: [makeVariant({ stock_quantity: 15 })] }) as never,
        );
      repository.updateVariantStock.mockResolvedValue(makeVariant({ stock_quantity: 15 }) as never);

      const result = await service.updateStock(BUSINESS_ID, ITEM_ID, {
        delta: -5,
        variantId: VARIANT_ID,
      });

      expect(repository.updateVariantStock).toHaveBeenCalledWith(VARIANT_ID, -5);
      expect(result.variantId).toBe(VARIANT_ID);
      expect(result.stockQuantity).toBe(15);
    });

    it('throws NotFound when the item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(
        service.updateStock(BUSINESS_ID, ITEM_ID, { delta: -1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when the variant is missing', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ variants: [] }) as never);
      await expect(
        service.updateStock(BUSINESS_ID, ITEM_ID, { delta: -1, variantId: VARIANT_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getStockLevel', () => {
    it('returns the tracked stock level with flags', async () => {
      repository.findItemById.mockResolvedValue(
        makeItem({ stock_quantity: 5, low_stock_threshold: 10 }) as never,
      );

      const result = await service.getStockLevel(BUSINESS_ID, ITEM_ID);

      expect(result.stockQuantity).toBe(5);
      expect(result.isLowStock).toBe(true);
      expect(result.isOutOfStock).toBe(false);
    });

    it('returns null stock when inventory is not tracked', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ track_inventory: false }) as never);

      const result = await service.getStockLevel(BUSINESS_ID, ITEM_ID);

      expect(result.stockQuantity).toBeNull();
      expect(result.trackInventory).toBe(false);
      expect(result.isLowStock).toBe(false);
      expect(result.isOutOfStock).toBe(false);
    });

    it('flags out of stock at zero', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ stock_quantity: 0 }) as never);

      const result = await service.getStockLevel(BUSINESS_ID, ITEM_ID);

      expect(result.isOutOfStock).toBe(true);
    });

    it('throws NotFound when the item is missing', async () => {
      repository.findItemById.mockResolvedValue(null);
      await expect(service.getStockLevel(BUSINESS_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────
  // EVENT LISTENERS
  // ─────────────────────────────────────────────

  describe('handleOrderCreated', () => {
    function makeOrderEvent(lineItems: unknown[]): OrderCreatedEvent & { lineItems: unknown[] } {
      return {
        id: 'evt-1',
        type: 'order.created',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-1',
        orderId: ORDER_ID,
        orderNumber: 'ORD-2026-00001',
        clientId: CLIENT_ID,
        totalPaise: 99800,
        currency: 'INR',
        lineItemCount: 1,
        lineItems,
      };
    }

    it('decrements stock for each line item', async () => {
      repository.findItemById
        .mockResolvedValueOnce(makeItem({ stock_quantity: 50 }) as never)
        .mockResolvedValueOnce(makeItem({ stock_quantity: 48 }) as never);
      repository.updateItemStock.mockResolvedValue(makeItem({ stock_quantity: 48 }) as never);

      await service.handleOrderCreated(makeOrderEvent([{ itemId: ITEM_ID, quantity: 2 }]) as never);

      expect(repository.updateItemStock).toHaveBeenCalledWith(ITEM_ID, -2);
    });

    it('skips items that do not track inventory', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ track_inventory: false }) as never);

      await service.handleOrderCreated(makeOrderEvent([{ itemId: ITEM_ID, quantity: 2 }]) as never);

      expect(repository.updateItemStock).not.toHaveBeenCalled();
    });

    it('does not throw when a line item fails', async () => {
      repository.findItemById.mockRejectedValue(new Error('db down'));

      await expect(
        service.handleOrderCreated(makeOrderEvent([{ itemId: ITEM_ID, quantity: 1 }]) as never),
      ).resolves.toBeUndefined();
    });

    it('handles an event with no line items gracefully', async () => {
      await expect(
        service.handleOrderCreated(makeOrderEvent([]) as never),
      ).resolves.toBeUndefined();
      expect(repository.updateItemStock).not.toHaveBeenCalled();
    });
  });

  describe('handleOrderCancelled', () => {
    it('restocks each line item', async () => {
      repository.findItemById.mockResolvedValue(makeItem({ stock_quantity: 48 }) as never);
      repository.updateItemStock.mockResolvedValue(makeItem({ stock_quantity: 50 }) as never);

      await service.handleOrderCancelled({
        id: 'evt-2',
        type: 'order.created',
        timestamp: new Date().toISOString(),
        businessId: BUSINESS_ID,
        correlationId: 'corr-2',
        orderId: ORDER_ID,
        orderNumber: 'ORD-2026-00001',
        clientId: CLIENT_ID,
        totalPaise: 99800,
        currency: 'INR',
        lineItemCount: 1,
        lineItems: [{ itemId: ITEM_ID, quantity: 2 }],
      } as never);

      expect(repository.updateItemStock).toHaveBeenCalledWith(ITEM_ID, 2);
    });
  });

  // ─────────────────────────────────────────────
  // MULTI-TENANT SCOPING
  // ─────────────────────────────────────────────

  describe('multi-tenant scoping', () => {
    it('threads the caller businessId into every read', async () => {
      repository.findItemById.mockResolvedValue(makeItem() as never);

      await service.getItem(OTHER_BUSINESS_ID, ITEM_ID);

      expect(repository.findItemById).toHaveBeenCalledWith(OTHER_BUSINESS_ID, ITEM_ID);
    });

    it('threads businessId into list queries', async () => {
      repository.listItems.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await service.listItems(OTHER_BUSINESS_ID, {});

      expect(repository.listItems.mock.calls[0]?.[0]).toBe(OTHER_BUSINESS_ID);
    });
  });
});
