/**
 * CatalogRepository unit tests.
 *
 * Three things here decide behaviour and are all branch-dense:
 *   - the create paths, which apply a column default for every optional field
 *     (`is_active` true, `currency` INR, `tax_inclusive` true, `type` PRODUCT…)
 *     — a wrong default silently ships a deactivated or mispriced item;
 *   - the partial-update paths, 24 fields wide on items, where an omitted key
 *     must not be written and a `null` must be;
 *   - `listItems`, which composes six optional filters, two of them booleans
 *     that have to survive a `false` value.
 *
 * PrismaService is mocked; assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { CatalogRepository } from './catalog.repository';
import type { ItemListFilters } from './catalog.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CATEGORY_ID = '00000000-0000-4000-b000-000000000001';
const ITEM_ID = '00000000-0000-4000-c000-000000000001';
const VARIANT_ID = '00000000-0000-4000-d000-000000000001';

describe('CatalogRepository', () => {
  let repository: CatalogRepository;
  let prisma: {
    catalog_categories: Record<'findFirst' | 'findMany' | 'create' | 'update', jest.Mock>;
    catalog_items: Record<
      'findFirst' | 'findMany' | 'count' | 'create' | 'update',
      jest.Mock
    >;
    catalog_variants: Record<'findFirst' | 'findMany' | 'create' | 'update', jest.Mock>;
  };

  const table = (name: 'catalog_categories' | 'catalog_items' | 'catalog_variants') => ({
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({ id: name }),
    update: jest.fn().mockResolvedValue({ id: name }),
  });

  beforeEach(async () => {
    prisma = {
      catalog_categories: table('catalog_categories'),
      catalog_items: table('catalog_items'),
      catalog_variants: table('catalog_variants'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CatalogRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(CatalogRepository);
  });

  // ── Categories ───────────────────────────────

  describe('categories', () => {
    it('defaults every optional column on create', async () => {
      await repository.createCategory({
        businessId: BUSINESS_ID,
        name: 'Apartments',
        slug: 'apartments',
      });

      expect(prisma.catalog_categories.create.mock.calls[0]![0].data).toEqual({
        business_id: BUSINESS_ID,
        parent_id: null,
        name: 'Apartments',
        slug: 'apartments',
        description: null,
        image_url: null,
        sort_order: 0,
        is_active: true,
        metadata: {},
      });
    });

    it('passes the optional columns through when supplied', async () => {
      await repository.createCategory({
        businessId: BUSINESS_ID,
        name: '2 BHK',
        slug: '2-bhk',
        parentId: CATEGORY_ID,
        description: 'Two bedroom',
        imageUrl: 'https://cdn.example.invalid/c.png',
        sortOrder: 4,
        isActive: false,
        metadata: { featured: true },
      });

      expect(prisma.catalog_categories.create.mock.calls[0]![0].data).toMatchObject({
        parent_id: CATEGORY_ID,
        sort_order: 4,
        is_active: false,
        metadata: { featured: true },
      });
    });

    it('reads a category with its live children', async () => {
      await repository.findCategoryById(BUSINESS_ID, CATEGORY_ID);

      const call = prisma.catalog_categories.findFirst.mock.calls[0]![0];
      expect(call.where).toEqual({
        id: CATEGORY_ID,
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
      expect(call.include.children.where).toEqual({ deleted_at: null });
    });

    it('writes only the category fields it was given', async () => {
      await repository.updateCategory(BUSINESS_ID, CATEGORY_ID, { sortOrder: 2 });

      expect(prisma.catalog_categories.update.mock.calls[0]![0]).toMatchObject({
        where: { id: CATEGORY_ID, business_id: BUSINESS_ID },
        data: { sort_order: 2 },
      });
    });

    it('maps every category field onto its column', async () => {
      await repository.updateCategory(BUSINESS_ID, CATEGORY_ID, {
        name: 'Villas',
        slug: 'villas',
        parentId: null,
        description: null,
        imageUrl: null,
        sortOrder: 0,
        isActive: false,
        metadata: {},
      });

      expect(prisma.catalog_categories.update.mock.calls[0]![0].data).toEqual({
        name: 'Villas',
        slug: 'villas',
        parent_id: null,
        description: null,
        image_url: null,
        sort_order: 0,
        is_active: false,
        metadata: {},
      });
    });

    it('soft-deletes rather than removing the row', async () => {
      await repository.softDeleteCategory(BUSINESS_ID, CATEGORY_ID);

      expect(prisma.catalog_categories.update.mock.calls[0]![0].data).toEqual({
        deleted_at: expect.any(Date),
      });
    });

    it('lists every category when no parent is named', async () => {
      await repository.listCategories(BUSINESS_ID);

      expect(prisma.catalog_categories.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        parent_id: undefined,
        deleted_at: null,
      });
    });

    it('lists the roots when the parent is explicitly null', async () => {
      // `null` and `undefined` mean different things: roots-only vs all.
      await repository.listCategories(BUSINESS_ID, null);

      expect(prisma.catalog_categories.findMany.mock.calls[0]![0].where.parent_id).toBeNull();
    });

    it('lists one parent’s children', async () => {
      await repository.listCategories(BUSINESS_ID, CATEGORY_ID);

      expect(prisma.catalog_categories.findMany.mock.calls[0]![0].where.parent_id).toBe(
        CATEGORY_ID,
      );
    });

    it('counts only live, active items in a category', async () => {
      await repository.countActiveItemsInCategory(BUSINESS_ID, CATEGORY_ID);

      expect(prisma.catalog_items.count.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        category_id: CATEGORY_ID,
        is_active: true,
        deleted_at: null,
      });
    });
  });

  // ── Items ────────────────────────────────────

  describe('items', () => {
    it('applies the full default set on create', async () => {
      await repository.createItem({
        businessId: BUSINESS_ID,
        name: '3 BHK Tower A',
        slug: '3-bhk-tower-a',
        price: new Prisma.Decimal(9500000),
      });

      expect(prisma.catalog_items.create.mock.calls[0]![0].data).toMatchObject({
        category_id: null,
        type: 'PRODUCT',
        currency: 'INR',
        tax_inclusive: true,
        sku: null,
        stock_quantity: null,
        track_inventory: false,
        allow_backorder: false,
        images: [],
        tags: [],
        ai_description: null,
        is_active: true,
        is_featured: false,
        sort_order: 0,
        metadata: {},
      });
      expect(
        (prisma.catalog_items.create.mock.calls[0]![0].data.tax_rate as Prisma.Decimal).toString(),
      ).toBe('0');
    });

    it('honours explicit falsey values instead of falling back to the default', async () => {
      // `isActive: false` and `taxInclusive: false` must survive `??`.
      await repository.createItem({
        businessId: BUSINESS_ID,
        name: 'Draft',
        slug: 'draft',
        price: new Prisma.Decimal(1),
        type: 'SERVICE',
        isActive: false,
        isFeatured: true,
        taxInclusive: false,
        trackInventory: true,
        allowBackorder: true,
        stockQuantity: 0,
        sortOrder: 0,
      });

      expect(prisma.catalog_items.create.mock.calls[0]![0].data).toMatchObject({
        type: 'SERVICE',
        is_active: false,
        is_featured: true,
        tax_inclusive: false,
        track_inventory: true,
        allow_backorder: true,
        stock_quantity: 0,
      });
    });

    it('reads an item with its category and live variants', async () => {
      await repository.findItemById(BUSINESS_ID, ITEM_ID);

      const call = prisma.catalog_items.findFirst.mock.calls[0]![0];
      expect(call.where).toEqual({ id: ITEM_ID, business_id: BUSINESS_ID, deleted_at: null });
      expect(call.include.variants.where).toEqual({ deleted_at: null });
    });

    it('writes only the item fields it was given', async () => {
      await repository.updateItem(BUSINESS_ID, ITEM_ID, { name: 'Renamed' });

      expect(prisma.catalog_items.update.mock.calls[0]![0]).toMatchObject({
        where: { id: ITEM_ID, business_id: BUSINESS_ID },
        data: { name: 'Renamed' },
      });
    });

    it('maps all 24 item fields onto their columns', async () => {
      const price = new Prisma.Decimal(100);

      await repository.updateItem(BUSINESS_ID, ITEM_ID, {
        categoryId: CATEGORY_ID,
        type: 'DIGITAL',
        name: 'n',
        slug: 's',
        description: 'd',
        shortDescription: 'sd',
        price,
        comparePrice: price,
        currency: 'USD',
        taxRate: price,
        taxInclusive: false,
        sku: 'SKU-1',
        barcode: 'BAR-1',
        stockQuantity: 5,
        trackInventory: true,
        allowBackorder: true,
        lowStockThreshold: 2,
        weightGrams: 900,
        images: ['a.png'],
        tags: ['new'],
        aiDescription: 'ai',
        isActive: false,
        isFeatured: true,
        sortOrder: 3,
        metadata: { k: 'v' },
      });

      expect(prisma.catalog_items.update.mock.calls[0]![0].data).toEqual({
        category_id: CATEGORY_ID,
        type: 'DIGITAL',
        name: 'n',
        slug: 's',
        description: 'd',
        short_description: 'sd',
        price,
        compare_price: price,
        currency: 'USD',
        tax_rate: price,
        tax_inclusive: false,
        sku: 'SKU-1',
        barcode: 'BAR-1',
        stock_quantity: 5,
        track_inventory: true,
        allow_backorder: true,
        low_stock_threshold: 2,
        weight_grams: 900,
        images: ['a.png'],
        tags: ['new'],
        ai_description: 'ai',
        is_active: false,
        is_featured: true,
        sort_order: 3,
        metadata: { k: 'v' },
      });
    });

    it('clears a nullable item column when passed null', async () => {
      await repository.updateItem(BUSINESS_ID, ITEM_ID, {
        categoryId: null,
        sku: null,
        comparePrice: null,
      });

      expect(prisma.catalog_items.update.mock.calls[0]![0].data).toEqual({
        category_id: null,
        sku: null,
        compare_price: null,
      });
    });

    it('deactivates an item as part of soft-deleting it', async () => {
      // A soft-deleted item that stayed active would still be sold by the AI.
      await repository.softDeleteItem(BUSINESS_ID, ITEM_ID);

      expect(prisma.catalog_items.update.mock.calls[0]![0].data).toEqual({
        deleted_at: expect.any(Date),
        is_active: false,
      });
    });

    it('adjusts stock atomically in both directions', async () => {
      await repository.updateItemStock(BUSINESS_ID, ITEM_ID, -2);

      expect(prisma.catalog_items.update.mock.calls[0]![0].data).toEqual({
        stock_quantity: { increment: -2 },
      });
    });

    it.each([
      ['findItemBySku', 'sku', 'SKU-1'],
      ['findItemBySlug', 'slug', 'a-slug'],
    ] as const)('%s scopes to the business and skips deleted rows', async (method, column, value) => {
      await repository[method](BUSINESS_ID, value);

      expect(prisma.catalog_items.findFirst.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        [column]: value,
        deleted_at: null,
      });
    });
  });

  // ── listItems ────────────────────────────────

  describe('listItems filters', () => {
    async function whereFor(filters: ItemListFilters) {
      await repository.listItems(BUSINESS_ID, filters);
      return prisma.catalog_items.findMany.mock.calls[0]![0].where;
    }

    it('applies no optional predicate when nothing is filtered', async () => {
      expect(await whereFor({})).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('defaults to page 1 / limit 20 and reports the page count', async () => {
      prisma.catalog_items.count.mockResolvedValue(41);

      const result = await repository.listItems(BUSINESS_ID, {});

      expect(prisma.catalog_items.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result).toMatchObject({ page: 1, limit: 20, total: 41, totalPages: 3 });
    });

    it('turns page/limit into a skip', async () => {
      await repository.listItems(BUSINESS_ID, { page: 2, limit: 50 });

      expect(prisma.catalog_items.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 50 }),
      );
    });

    it('filters by category and type', async () => {
      expect(await whereFor({ categoryId: CATEGORY_ID, type: 'SERVICE' })).toMatchObject({
        category_id: CATEGORY_ID,
        type: 'SERVICE',
      });
    });

    it.each([true, false])('filters on isActive=%s, including the false case', async (value) => {
      // `!== undefined`, not truthiness — otherwise "show me the inactive ones"
      // silently returns everything.
      expect((await whereFor({ isActive: value })).is_active).toBe(value);
    });

    it.each([true, false])('filters on isFeatured=%s, including the false case', async (value) => {
      expect((await whereFor({ isFeatured: value })).is_featured).toBe(value);
    });

    it('matches any of the given tags but ignores an empty list', async () => {
      expect((await whereFor({ tags: ['new', 'sale'] })).tags).toEqual({
        hasSome: ['new', 'sale'],
      });
      prisma.catalog_items.findMany.mockClear();
      expect(await whereFor({ tags: [] })).not.toHaveProperty('tags');
    });

    it('searches name, description, sku and short description', async () => {
      expect((await whereFor({ search: 'tower' })).OR).toEqual([
        { name: { contains: 'tower', mode: 'insensitive' } },
        { description: { contains: 'tower', mode: 'insensitive' } },
        { sku: { contains: 'tower', mode: 'insensitive' } },
        { short_description: { contains: 'tower', mode: 'insensitive' } },
      ]);
    });

    it('ignores an empty search string', async () => {
      expect(await whereFor({ search: '' })).not.toHaveProperty('OR');
    });

    it('counts with the same where as the page query', async () => {
      await repository.listItems(BUSINESS_ID, { search: 'x', isActive: true });

      expect(prisma.catalog_items.count.mock.calls[0]![0].where).toEqual(
        prisma.catalog_items.findMany.mock.calls[0]![0].where,
      );
    });
  });

  describe('searchCatalog', () => {
    it('searches active items only and includes the AI description', async () => {
      await repository.searchCatalog(BUSINESS_ID, 'baner');

      const call = prisma.catalog_items.findMany.mock.calls[0]![0];
      expect(call.where).toMatchObject({ business_id: BUSINESS_ID, is_active: true, deleted_at: null });
      expect(call.where.OR).toHaveLength(5);
      expect(call.where.OR).toContainEqual({
        ai_description: { contains: 'baner', mode: 'insensitive' },
      });
    });

    it('defaults to ten results and honours an explicit limit', async () => {
      await repository.searchCatalog(BUSINESS_ID, 'q');
      expect(prisma.catalog_items.findMany.mock.calls[0]![0].take).toBe(10);

      await repository.searchCatalog(BUSINESS_ID, 'q', 3);
      expect(prisma.catalog_items.findMany.mock.calls[1]![0].take).toBe(3);
    });
  });

  // ── Variants ─────────────────────────────────

  describe('variants', () => {
    it('defaults a variant’s optional columns, leaving price inherited', async () => {
      await repository.createVariant({
        businessId: BUSINESS_ID,
        itemId: ITEM_ID,
        name: 'East facing',
      });

      expect(prisma.catalog_variants.create.mock.calls[0]![0].data).toEqual({
        business_id: BUSINESS_ID,
        item_id: ITEM_ID,
        name: 'East facing',
        sku: null,
        barcode: null,
        // null price means "inherit the parent item's price".
        price: null,
        compare_price: null,
        attributes: {},
        stock_quantity: null,
        is_active: true,
        sort_order: 0,
        image_url: null,
      });
    });

    it('keeps an explicit zero price rather than inheriting', async () => {
      await repository.createVariant({
        businessId: BUSINESS_ID,
        itemId: ITEM_ID,
        name: 'Free trial',
        price: new Prisma.Decimal(0),
      });

      expect(
        (prisma.catalog_variants.create.mock.calls[0]![0].data.price as Prisma.Decimal).toString(),
      ).toBe('0');
    });

    it('writes only the variant fields it was given', async () => {
      await repository.updateVariant(BUSINESS_ID, VARIANT_ID, { sortOrder: 1 });

      expect(prisma.catalog_variants.update.mock.calls[0]![0]).toMatchObject({
        where: { id: VARIANT_ID, business_id: BUSINESS_ID },
        data: { sort_order: 1 },
      });
    });

    it('maps every variant field onto its column', async () => {
      const price = new Prisma.Decimal(50);

      await repository.updateVariant(BUSINESS_ID, VARIANT_ID, {
        name: 'n',
        sku: 'v-sku',
        barcode: 'v-bar',
        price,
        comparePrice: price,
        attributes: { facing: 'east' },
        stockQuantity: 2,
        isActive: false,
        sortOrder: 9,
        imageUrl: 'https://cdn.example.invalid/v.png',
      });

      expect(prisma.catalog_variants.update.mock.calls[0]![0].data).toEqual({
        name: 'n',
        sku: 'v-sku',
        barcode: 'v-bar',
        price,
        compare_price: price,
        attributes: { facing: 'east' },
        stock_quantity: 2,
        is_active: false,
        sort_order: 9,
        image_url: 'https://cdn.example.invalid/v.png',
      });
    });

    it('deactivates a variant as part of soft-deleting it', async () => {
      await repository.softDeleteVariant(BUSINESS_ID, VARIANT_ID);

      expect(prisma.catalog_variants.update.mock.calls[0]![0].data).toEqual({
        deleted_at: expect.any(Date),
        is_active: false,
      });
    });

    it('adjusts variant stock atomically', async () => {
      await repository.updateVariantStock(BUSINESS_ID, VARIANT_ID, 5);

      expect(prisma.catalog_variants.update.mock.calls[0]![0].data).toEqual({
        stock_quantity: { increment: 5 },
      });
    });

    it('lists a single item’s live variants in sort order', async () => {
      await repository.listVariantsByItemId(BUSINESS_ID, ITEM_ID);

      expect(prisma.catalog_variants.findMany.mock.calls[0]![0]).toMatchObject({
        where: { business_id: BUSINESS_ID, item_id: ITEM_ID, deleted_at: null },
        orderBy: { sort_order: 'asc' },
      });
    });

    it.each([
      ['findVariantById', 'id', VARIANT_ID],
      ['findVariantBySku', 'sku', 'v-sku'],
    ] as const)('%s scopes to the business and skips deleted rows', async (method, column, value) => {
      await repository[method](BUSINESS_ID, value);

      expect(prisma.catalog_variants.findFirst.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        [column]: value,
        deleted_at: null,
      });
    });
  });
});
