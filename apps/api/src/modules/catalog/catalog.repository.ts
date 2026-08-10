import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { Prisma } from '@prisma/client';
import type {
  catalog_categories,
  catalog_items,
  catalog_variants,
  catalog_packages,
} from '@prisma/client';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface PaginatedItems {
  data: (catalog_items & { category?: catalog_categories | null; variants?: catalog_variants[] })[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ItemListFilters {
  search?: string;
  categoryId?: string;
  type?: string;
  isActive?: boolean;
  isFeatured?: boolean;
  tags?: string[];
  page?: number;
  limit?: number;
}

export interface CreateCategoryData {
  businessId: string;
  parentId?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateCategoryData {
  name?: string;
  slug?: string;
  parentId?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  metadata?: Prisma.InputJsonValue;
}

export interface CreateItemData {
  businessId: string;
  categoryId?: string | null;
  type?: string;
  name: string;
  slug: string;
  description?: string | null;
  shortDescription?: string | null;
  price: Prisma.Decimal;
  comparePrice?: Prisma.Decimal | null;
  currency?: string;
  taxRate?: Prisma.Decimal;
  taxInclusive?: boolean;
  sku?: string | null;
  barcode?: string | null;
  stockQuantity?: number | null;
  trackInventory?: boolean;
  allowBackorder?: boolean;
  lowStockThreshold?: number | null;
  weightGrams?: number | null;
  images?: Prisma.InputJsonValue;
  tags?: string[];
  aiDescription?: string | null;
  isActive?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateItemData {
  categoryId?: string | null;
  type?: string;
  name?: string;
  slug?: string;
  description?: string | null;
  shortDescription?: string | null;
  price?: Prisma.Decimal;
  comparePrice?: Prisma.Decimal | null;
  currency?: string;
  taxRate?: Prisma.Decimal;
  taxInclusive?: boolean;
  sku?: string | null;
  barcode?: string | null;
  stockQuantity?: number | null;
  trackInventory?: boolean;
  allowBackorder?: boolean;
  lowStockThreshold?: number | null;
  weightGrams?: number | null;
  images?: Prisma.InputJsonValue;
  tags?: string[];
  aiDescription?: string | null;
  isActive?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface CreateVariantData {
  businessId: string;
  itemId: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  price?: Prisma.Decimal | null;
  comparePrice?: Prisma.Decimal | null;
  attributes?: Prisma.InputJsonValue;
  stockQuantity?: number | null;
  isActive?: boolean;
  sortOrder?: number;
  imageUrl?: string | null;
}

export interface UpdateVariantData {
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  price?: Prisma.Decimal | null;
  comparePrice?: Prisma.Decimal | null;
  attributes?: Prisma.InputJsonValue;
  stockQuantity?: number | null;
  isActive?: boolean;
  sortOrder?: number;
  imageUrl?: string | null;
}

/**
 * CatalogRepository — all Prisma queries for the Catalog module.
 *
 * Every query includes businessId scoping. Soft-deleted records
 * are excluded by default (deleted_at: null).
 */
@Injectable()
export class CatalogRepository {
  private readonly logger = new Logger(CatalogRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────
  // CATEGORIES
  // ─────────────────────────────────────────────

  async createCategory(data: CreateCategoryData): Promise<catalog_categories> {
    return this.prisma.catalog_categories.create({
      data: {
        business_id: data.businessId,
        parent_id: data.parentId ?? null,
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        image_url: data.imageUrl ?? null,
        sort_order: data.sortOrder ?? 0,
        is_active: data.isActive ?? true,
        metadata: data.metadata ?? {},
      },
    });
  }

  async findCategoryById(
    businessId: string,
    categoryId: string,
  ): Promise<catalog_categories | null> {
    return this.prisma.catalog_categories.findFirst({
      where: {
        id: categoryId,
        business_id: businessId,
        deleted_at: null,
      },
      include: {
        children: {
          where: { deleted_at: null },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
  }

  async updateCategory(
    businessId: string,
    categoryId: string,
    data: UpdateCategoryData,
  ): Promise<catalog_categories> {
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData['name'] = data.name;
    if (data.slug !== undefined) updateData['slug'] = data.slug;
    if (data.parentId !== undefined) updateData['parent_id'] = data.parentId;
    if (data.description !== undefined) updateData['description'] = data.description;
    if (data.imageUrl !== undefined) updateData['image_url'] = data.imageUrl;
    if (data.sortOrder !== undefined) updateData['sort_order'] = data.sortOrder;
    if (data.isActive !== undefined) updateData['is_active'] = data.isActive;
    if (data.metadata !== undefined) updateData['metadata'] = data.metadata;

    return this.prisma.catalog_categories.update({
      where: { id: categoryId, business_id: businessId },
      data: updateData,
    });
  }

  async softDeleteCategory(
    businessId: string,
    categoryId: string,
  ): Promise<catalog_categories> {
    return this.prisma.catalog_categories.update({
      where: { id: categoryId, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  async listCategories(
    businessId: string,
    parentId?: string | null,
  ): Promise<catalog_categories[]> {
    return this.prisma.catalog_categories.findMany({
      where: {
        business_id: businessId,
        parent_id: parentId === undefined ? undefined : parentId,
        deleted_at: null,
      },
      include: {
        children: {
          where: { deleted_at: null },
          orderBy: { sort_order: 'asc' },
        },
      },
      orderBy: { sort_order: 'asc' },
    });
  }

  async countActiveItemsInCategory(
    businessId: string,
    categoryId: string,
  ): Promise<number> {
    return this.prisma.catalog_items.count({
      where: {
        business_id: businessId,
        category_id: categoryId,
        is_active: true,
        deleted_at: null,
      },
    });
  }

  // ─────────────────────────────────────────────
  // ITEMS
  // ─────────────────────────────────────────────

  async createItem(data: CreateItemData): Promise<catalog_items> {
    return this.prisma.catalog_items.create({
      data: {
        business_id: data.businessId,
        category_id: data.categoryId ?? null,
        type: (data.type as 'PRODUCT' | 'SERVICE' | 'DIGITAL' | 'SUBSCRIPTION') ?? 'PRODUCT',
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        short_description: data.shortDescription ?? null,
        price: data.price,
        compare_price: data.comparePrice ?? null,
        currency: data.currency ?? 'INR',
        tax_rate: data.taxRate ?? new Prisma.Decimal(0),
        tax_inclusive: data.taxInclusive ?? true,
        sku: data.sku ?? null,
        barcode: data.barcode ?? null,
        stock_quantity: data.stockQuantity ?? null,
        track_inventory: data.trackInventory ?? false,
        allow_backorder: data.allowBackorder ?? false,
        low_stock_threshold: data.lowStockThreshold ?? null,
        weight_grams: data.weightGrams ?? null,
        images: data.images ?? [],
        tags: data.tags ?? [],
        ai_description: data.aiDescription ?? null,
        is_active: data.isActive ?? true,
        is_featured: data.isFeatured ?? false,
        sort_order: data.sortOrder ?? 0,
        metadata: data.metadata ?? {},
      },
      include: {
        category: true,
        variants: { where: { deleted_at: null }, orderBy: { sort_order: 'asc' } },
      },
    });
  }

  async findItemById(
    businessId: string,
    itemId: string,
  ): Promise<(catalog_items & { category: catalog_categories | null; variants: catalog_variants[] }) | null> {
    return this.prisma.catalog_items.findFirst({
      where: {
        id: itemId,
        business_id: businessId,
        deleted_at: null,
      },
      include: {
        category: true,
        variants: { where: { deleted_at: null }, orderBy: { sort_order: 'asc' } },
      },
    });
  }

  async updateItem(
    businessId: string,
    itemId: string,
    data: UpdateItemData,
  ): Promise<catalog_items & { category: catalog_categories | null; variants: catalog_variants[] }> {
    const updateData: Record<string, unknown> = {};
    if (data.categoryId !== undefined) updateData['category_id'] = data.categoryId;
    if (data.type !== undefined) updateData['type'] = data.type;
    if (data.name !== undefined) updateData['name'] = data.name;
    if (data.slug !== undefined) updateData['slug'] = data.slug;
    if (data.description !== undefined) updateData['description'] = data.description;
    if (data.shortDescription !== undefined) updateData['short_description'] = data.shortDescription;
    if (data.price !== undefined) updateData['price'] = data.price;
    if (data.comparePrice !== undefined) updateData['compare_price'] = data.comparePrice;
    if (data.currency !== undefined) updateData['currency'] = data.currency;
    if (data.taxRate !== undefined) updateData['tax_rate'] = data.taxRate;
    if (data.taxInclusive !== undefined) updateData['tax_inclusive'] = data.taxInclusive;
    if (data.sku !== undefined) updateData['sku'] = data.sku;
    if (data.barcode !== undefined) updateData['barcode'] = data.barcode;
    if (data.stockQuantity !== undefined) updateData['stock_quantity'] = data.stockQuantity;
    if (data.trackInventory !== undefined) updateData['track_inventory'] = data.trackInventory;
    if (data.allowBackorder !== undefined) updateData['allow_backorder'] = data.allowBackorder;
    if (data.lowStockThreshold !== undefined) updateData['low_stock_threshold'] = data.lowStockThreshold;
    if (data.weightGrams !== undefined) updateData['weight_grams'] = data.weightGrams;
    if (data.images !== undefined) updateData['images'] = data.images;
    if (data.tags !== undefined) updateData['tags'] = data.tags;
    if (data.aiDescription !== undefined) updateData['ai_description'] = data.aiDescription;
    if (data.isActive !== undefined) updateData['is_active'] = data.isActive;
    if (data.isFeatured !== undefined) updateData['is_featured'] = data.isFeatured;
    if (data.sortOrder !== undefined) updateData['sort_order'] = data.sortOrder;
    if (data.metadata !== undefined) updateData['metadata'] = data.metadata;

    return this.prisma.catalog_items.update({
      where: { id: itemId, business_id: businessId },
      data: updateData,
      include: {
        category: true,
        variants: { where: { deleted_at: null }, orderBy: { sort_order: 'asc' } },
      },
    });
  }

  async softDeleteItem(
    businessId: string,
    itemId: string,
  ): Promise<catalog_items> {
    return this.prisma.catalog_items.update({
      where: { id: itemId, business_id: businessId },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  async listItems(
    businessId: string,
    filters: ItemListFilters,
  ): Promise<PaginatedItems> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.catalog_itemsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };

    if (filters.categoryId) {
      where.category_id = filters.categoryId;
    }
    if (filters.type) {
      where.type = filters.type as 'PRODUCT' | 'SERVICE' | 'DIGITAL' | 'SUBSCRIPTION';
    }
    if (filters.isActive !== undefined) {
      where.is_active = filters.isActive;
    }
    if (filters.isFeatured !== undefined) {
      where.is_featured = filters.isFeatured;
    }
    if (filters.tags && filters.tags.length > 0) {
      where.tags = { hasSome: filters.tags };
    }
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
        { sku: { contains: filters.search, mode: 'insensitive' } },
        { short_description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.catalog_items.findMany({
        where,
        include: {
          category: true,
          variants: { where: { deleted_at: null }, orderBy: { sort_order: 'asc' } },
        },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.catalog_items.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async searchCatalog(
    businessId: string,
    query: string,
    limit: number = 10,
  ): Promise<(catalog_items & { category: catalog_categories | null; variants: catalog_variants[] })[]> {
    return this.prisma.catalog_items.findMany({
      where: {
        business_id: businessId,
        is_active: true,
        deleted_at: null,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { sku: { contains: query, mode: 'insensitive' } },
          { ai_description: { contains: query, mode: 'insensitive' } },
          { short_description: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: {
        category: true,
        variants: { where: { deleted_at: null }, orderBy: { sort_order: 'asc' } },
      },
      orderBy: { sort_order: 'asc' },
      take: limit,
    });
  }

  async findItemBySku(
    businessId: string,
    sku: string,
  ): Promise<catalog_items | null> {
    return this.prisma.catalog_items.findFirst({
      where: {
        business_id: businessId,
        sku,
        deleted_at: null,
      },
    });
  }

  async findItemBySlug(
    businessId: string,
    slug: string,
  ): Promise<catalog_items | null> {
    return this.prisma.catalog_items.findFirst({
      where: {
        business_id: businessId,
        slug,
        deleted_at: null,
      },
    });
  }

  /**
   * Atomically increment or decrement stock_quantity on an item.
   * Returns the updated item.
   */
  async updateItemStock(
    businessId: string,
    itemId: string,
    delta: number,
  ): Promise<catalog_items> {
    return this.prisma.catalog_items.update({
      where: { id: itemId, business_id: businessId },
      data: {
        stock_quantity: { increment: delta },
      },
    });
  }

  // ─────────────────────────────────────────────
  // VARIANTS
  // ─────────────────────────────────────────────

  async createVariant(data: CreateVariantData): Promise<catalog_variants> {
    return this.prisma.catalog_variants.create({
      data: {
        business_id: data.businessId,
        item_id: data.itemId,
        name: data.name,
        sku: data.sku ?? null,
        barcode: data.barcode ?? null,
        price: data.price ?? null,
        compare_price: data.comparePrice ?? null,
        attributes: data.attributes ?? {},
        stock_quantity: data.stockQuantity ?? null,
        is_active: data.isActive ?? true,
        sort_order: data.sortOrder ?? 0,
        image_url: data.imageUrl ?? null,
      },
    });
  }

  async findVariantById(
    businessId: string,
    variantId: string,
  ): Promise<catalog_variants | null> {
    return this.prisma.catalog_variants.findFirst({
      where: {
        id: variantId,
        business_id: businessId,
        deleted_at: null,
      },
    });
  }

  async updateVariant(
    businessId: string,
    variantId: string,
    data: UpdateVariantData,
  ): Promise<catalog_variants> {
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData['name'] = data.name;
    if (data.sku !== undefined) updateData['sku'] = data.sku;
    if (data.barcode !== undefined) updateData['barcode'] = data.barcode;
    if (data.price !== undefined) updateData['price'] = data.price;
    if (data.comparePrice !== undefined) updateData['compare_price'] = data.comparePrice;
    if (data.attributes !== undefined) updateData['attributes'] = data.attributes;
    if (data.stockQuantity !== undefined) updateData['stock_quantity'] = data.stockQuantity;
    if (data.isActive !== undefined) updateData['is_active'] = data.isActive;
    if (data.sortOrder !== undefined) updateData['sort_order'] = data.sortOrder;
    if (data.imageUrl !== undefined) updateData['image_url'] = data.imageUrl;

    return this.prisma.catalog_variants.update({
      where: { id: variantId, business_id: businessId },
      data: updateData,
    });
  }

  async softDeleteVariant(
    businessId: string,
    variantId: string,
  ): Promise<catalog_variants> {
    return this.prisma.catalog_variants.update({
      where: { id: variantId, business_id: businessId },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  async listVariantsByItemId(
    businessId: string,
    itemId: string,
  ): Promise<catalog_variants[]> {
    return this.prisma.catalog_variants.findMany({
      where: {
        business_id: businessId,
        item_id: itemId,
        deleted_at: null,
      },
      orderBy: { sort_order: 'asc' },
    });
  }

  /**
   * Atomically increment or decrement stock_quantity on a variant.
   */
  async updateVariantStock(
    businessId: string,
    variantId: string,
    delta: number,
  ): Promise<catalog_variants> {
    return this.prisma.catalog_variants.update({
      where: { id: variantId, business_id: businessId },
      data: {
        stock_quantity: { increment: delta },
      },
    });
  }

  async findVariantBySku(
    businessId: string,
    sku: string,
  ): Promise<catalog_variants | null> {
    return this.prisma.catalog_variants.findFirst({
      where: {
        business_id: businessId,
        sku,
        deleted_at: null,
      },
    });
  }
}
