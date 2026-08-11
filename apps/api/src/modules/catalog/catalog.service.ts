import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  CatalogItemType,
} from '@gosumo/shared';
import type {
  CatalogItemCreatedEvent,
  CatalogItemUpdatedEvent,
  CatalogStockLowEvent,
  CatalogStockOutEvent,
  OrderCreatedEvent,
} from '@gosumo/shared';
import { CatalogRepository } from './catalog.repository';
import type { UpdateItemData } from './catalog.repository';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateItemDto,
  UpdateItemDto,
  ItemQueryDto,
  CreateVariantDto,
  UpdateVariantDto,
  StockUpdateDto,
  CategoryResponseDto,
  ItemResponseDto,
  VariantResponseDto,
  PaginatedItemsResponseDto,
  StockLevelDto,
  EffectivePriceDto,
} from './dto';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Convert paise (integer) to Prisma Decimal (rupees). */
function paiseToDecimal(paise: number): Prisma.Decimal {
  return new Prisma.Decimal(paise).div(100);
}

/** Convert Prisma Decimal (rupees) to paise (integer). */
function decimalToPaise(d: Prisma.Decimal | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  return new Prisma.Decimal(d).mul(100).round().toNumber();
}

/** Slugify a name for URL-safe usage. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Generate a short SKU with a random suffix. */
function generateSKU(): string {
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ITM-${suffix}`;
}

/** Shape of line items that order events may carry. */
interface OrderLineItem {
  itemId: string;
  variantId?: string;
  quantity: number;
}

/**
 * CatalogService — business logic for the Catalog module.
 *
 * Handles category CRUD, item CRUD with SKU auto-generation,
 * variant management, stock tracking with event emission,
 * and effective price calculation.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly repository: CatalogRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CATEGORIES
  // ─────────────────────────────────────────────

  async createCategory(
    businessId: string,
    dto: CreateCategoryDto,
  ): Promise<CategoryResponseDto> {
    const slug = dto.slug || slugify(dto.name);

    if (dto.parentId) {
      const parent = await this.repository.findCategoryById(businessId, dto.parentId);
      if (!parent) {
        throw new NotFoundException(`Parent category ${dto.parentId} not found`);
      }
    }

    const category = await this.repository.createCategory({
      businessId,
      parentId: dto.parentId ?? null,
      name: dto.name,
      slug,
      description: dto.description,
      imageUrl: dto.imageUrl,
      sortOrder: dto.sortOrder,
      isActive: dto.isActive,
    });

    return this.mapCategoryResponse(category);
  }

  async getCategory(
    businessId: string,
    categoryId: string,
  ): Promise<CategoryResponseDto> {
    const category = await this.repository.findCategoryById(businessId, categoryId);
    if (!category) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }
    return this.mapCategoryResponse(category);
  }

  async updateCategory(
    businessId: string,
    categoryId: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    const existing = await this.repository.findCategoryById(businessId, categoryId);
    if (!existing) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }

    if (dto.parentId) {
      if (dto.parentId === categoryId) {
        throw new UnprocessableEntityException('Category cannot be its own parent');
      }
      const parent = await this.repository.findCategoryById(businessId, dto.parentId);
      if (!parent) {
        throw new NotFoundException(`Parent category ${dto.parentId} not found`);
      }
    }

    const updated = await this.repository.updateCategory(businessId, categoryId, {
      name: dto.name,
      slug: dto.slug,
      parentId: dto.parentId,
      description: dto.description,
      imageUrl: dto.imageUrl,
      sortOrder: dto.sortOrder,
      isActive: dto.isActive,
    });

    return this.mapCategoryResponse(updated);
  }

  async deleteCategory(
    businessId: string,
    categoryId: string,
  ): Promise<void> {
    const existing = await this.repository.findCategoryById(businessId, categoryId);
    if (!existing) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }

    const activeItemCount = await this.repository.countActiveItemsInCategory(
      businessId,
      categoryId,
    );
    if (activeItemCount > 0) {
      throw new UnprocessableEntityException(
        `Cannot delete category with ${activeItemCount} active item(s). Deactivate items first.`,
      );
    }

    await this.repository.softDeleteCategory(businessId, categoryId);
  }

  async listCategories(
    businessId: string,
    parentId?: string | null,
  ): Promise<CategoryResponseDto[]> {
    const categories = await this.repository.listCategories(businessId, parentId);
    return categories.map((c) => this.mapCategoryResponse(c));
  }

  // ─────────────────────────────────────────────
  // ITEMS
  // ─────────────────────────────────────────────

  async createItem(
    businessId: string,
    dto: CreateItemDto,
  ): Promise<ItemResponseDto> {
    const slug = dto.slug || slugify(dto.name);

    // Check slug uniqueness
    const existingSlug = await this.repository.findItemBySlug(businessId, slug);
    if (existingSlug) {
      throw new ConflictException(`Item with slug "${slug}" already exists`);
    }

    // Auto-generate or validate SKU
    let sku = dto.sku || generateSKU();
    if (dto.sku) {
      const existingSku = await this.repository.findItemBySku(businessId, dto.sku);
      if (existingSku) {
        throw new ConflictException(`Item with SKU "${dto.sku}" already exists`);
      }
    } else {
      // Ensure generated SKU is unique
      let attempts = 0;
      while (await this.repository.findItemBySku(businessId, sku)) {
        sku = generateSKU();
        attempts++;
        if (attempts > 10) {
          throw new ConflictException('Failed to generate a unique SKU');
        }
      }
    }

    // Validate category exists if provided
    if (dto.categoryId) {
      const category = await this.repository.findCategoryById(businessId, dto.categoryId);
      if (!category) {
        throw new NotFoundException(`Category ${dto.categoryId} not found`);
      }
    }

    // Auto-generate ai_description if not provided
    const aiDescription =
      dto.aiDescription ??
      this.generateAiDescription(dto.name, dto.description, dto.shortDescription, dto.tags);

    const item = await this.repository.createItem({
      businessId,
      categoryId: dto.categoryId,
      type: dto.type ?? CatalogItemType.PRODUCT,
      name: dto.name,
      slug,
      description: dto.description,
      shortDescription: dto.shortDescription,
      price: paiseToDecimal(dto.pricePaise),
      comparePrice: dto.comparePricePaise != null ? paiseToDecimal(dto.comparePricePaise) : null,
      currency: dto.currency,
      taxRate: dto.taxRate != null ? new Prisma.Decimal(dto.taxRate) : undefined,
      taxInclusive: dto.taxInclusive,
      sku,
      barcode: dto.barcode,
      stockQuantity: dto.stockQuantity,
      trackInventory: dto.trackInventory,
      allowBackorder: dto.allowBackorder,
      lowStockThreshold: dto.lowStockThreshold,
      weightGrams: dto.weightGrams,
      images: dto.images as Prisma.InputJsonValue,
      tags: dto.tags,
      aiDescription,
      isActive: dto.isActive,
      isFeatured: dto.isFeatured,
      sortOrder: dto.sortOrder,
    });

    // Emit domain event
    const event: CatalogItemCreatedEvent = {
      id: generateId(),
      type: 'catalog.item.created',
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      itemId: item.id,
      sku: item.sku ?? sku,
      categoryId: item.category_id ?? undefined,
    };
    this.eventEmitter.emit('catalog.item.created', event);

    this.logger.log(
      `Created catalog item ${item.id} (SKU: ${sku}) for business ${businessId}`,
    );

    return this.mapItemResponse(item);
  }

  async getItem(
    businessId: string,
    itemId: string,
  ): Promise<ItemResponseDto> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    return this.mapItemResponse(item);
  }

  async updateItem(
    businessId: string,
    itemId: string,
    dto: UpdateItemDto,
  ): Promise<ItemResponseDto> {
    const existing = await this.repository.findItemById(businessId, itemId);
    if (!existing) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    // Validate SKU uniqueness if changing
    if (dto.sku && dto.sku !== existing.sku) {
      const existingSku = await this.repository.findItemBySku(businessId, dto.sku);
      if (existingSku && existingSku.id !== itemId) {
        throw new ConflictException(`Item with SKU "${dto.sku}" already exists`);
      }
    }

    // Validate slug uniqueness if changing
    if (dto.slug && dto.slug !== existing.slug) {
      const existingSlug = await this.repository.findItemBySlug(businessId, dto.slug);
      if (existingSlug && existingSlug.id !== itemId) {
        throw new ConflictException(`Item with slug "${dto.slug}" already exists`);
      }
    }

    // Validate category if changing
    if (dto.categoryId) {
      const category = await this.repository.findCategoryById(businessId, dto.categoryId);
      if (!category) {
        throw new NotFoundException(`Category ${dto.categoryId} not found`);
      }
    }

    // Build update data
    const changedFields: string[] = [];
    const updateData: UpdateItemData = {};

    if (dto.name !== undefined) { updateData.name = dto.name; changedFields.push('name'); }
    if (dto.slug !== undefined) { updateData.slug = dto.slug; changedFields.push('slug'); }
    if (dto.type !== undefined) { updateData.type = dto.type; changedFields.push('type'); }
    if (dto.categoryId !== undefined) { updateData.categoryId = dto.categoryId; changedFields.push('categoryId'); }
    if (dto.description !== undefined) { updateData.description = dto.description; changedFields.push('description'); }
    if (dto.shortDescription !== undefined) { updateData.shortDescription = dto.shortDescription; changedFields.push('shortDescription'); }
    if (dto.pricePaise !== undefined) { updateData.price = paiseToDecimal(dto.pricePaise); changedFields.push('price'); }
    if (dto.comparePricePaise !== undefined) {
      updateData.comparePrice = dto.comparePricePaise != null ? paiseToDecimal(dto.comparePricePaise) : null;
      changedFields.push('comparePrice');
    }
    if (dto.currency !== undefined) { updateData.currency = dto.currency; changedFields.push('currency'); }
    if (dto.taxRate !== undefined) { updateData.taxRate = new Prisma.Decimal(dto.taxRate); changedFields.push('taxRate'); }
    if (dto.taxInclusive !== undefined) { updateData.taxInclusive = dto.taxInclusive; changedFields.push('taxInclusive'); }
    if (dto.sku !== undefined) { updateData.sku = dto.sku; changedFields.push('sku'); }
    if (dto.barcode !== undefined) { updateData.barcode = dto.barcode; changedFields.push('barcode'); }
    if (dto.stockQuantity !== undefined) { updateData.stockQuantity = dto.stockQuantity; changedFields.push('stockQuantity'); }
    if (dto.trackInventory !== undefined) { updateData.trackInventory = dto.trackInventory; changedFields.push('trackInventory'); }
    if (dto.allowBackorder !== undefined) { updateData.allowBackorder = dto.allowBackorder; changedFields.push('allowBackorder'); }
    if (dto.lowStockThreshold !== undefined) { updateData.lowStockThreshold = dto.lowStockThreshold; changedFields.push('lowStockThreshold'); }
    if (dto.weightGrams !== undefined) { updateData.weightGrams = dto.weightGrams; changedFields.push('weightGrams'); }
    if (dto.images !== undefined) { updateData.images = dto.images as Prisma.InputJsonValue; changedFields.push('images'); }
    if (dto.tags !== undefined) { updateData.tags = dto.tags; changedFields.push('tags'); }
    if (dto.aiDescription !== undefined) { updateData.aiDescription = dto.aiDescription; changedFields.push('aiDescription'); }
    if (dto.isActive !== undefined) { updateData.isActive = dto.isActive; changedFields.push('isActive'); }
    if (dto.isFeatured !== undefined) { updateData.isFeatured = dto.isFeatured; changedFields.push('isFeatured'); }
    if (dto.sortOrder !== undefined) { updateData.sortOrder = dto.sortOrder; changedFields.push('sortOrder'); }

    const updated = await this.repository.updateItem(businessId, itemId, updateData);

    // Emit domain event
    if (changedFields.length > 0) {
      const event: CatalogItemUpdatedEvent = {
        id: generateId(),
        type: 'catalog.item.updated',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        itemId,
        changedFields,
      };
      this.eventEmitter.emit('catalog.item.updated', event);
    }

    return this.mapItemResponse(updated);
  }

  async deleteItem(
    businessId: string,
    itemId: string,
  ): Promise<void> {
    const existing = await this.repository.findItemById(businessId, itemId);
    if (!existing) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    await this.repository.softDeleteItem(businessId, itemId);
    this.logger.log(`Soft-deleted catalog item ${itemId} for business ${businessId}`);
  }

  async listItems(
    businessId: string,
    query: ItemQueryDto,
  ): Promise<PaginatedItemsResponseDto> {
    const filters = {
      search: query.search,
      categoryId: query.categoryId,
      type: query.type,
      isActive: query.isActive,
      isFeatured: query.isFeatured,
      tags: query.tags ? query.tags.split(',').map((t) => t.trim()) : undefined,
      page: query.page,
      limit: query.limit,
    };

    const result = await this.repository.listItems(businessId, filters);

    return {
      data: result.data.map((item) => this.mapItemResponse(item)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async searchCatalog(
    businessId: string,
    query: string,
    limit: number = 10,
  ): Promise<ItemResponseDto[]> {
    const items = await this.repository.searchCatalog(businessId, query, limit);
    return items.map((item) => this.mapItemResponse(item));
  }

  // ─────────────────────────────────────────────
  // VARIANTS
  // ─────────────────────────────────────────────

  async addVariant(
    businessId: string,
    itemId: string,
    dto: CreateVariantDto,
  ): Promise<VariantResponseDto> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    // Validate SKU uniqueness if provided
    if (dto.sku) {
      const existingVariantSku = await this.repository.findVariantBySku(businessId, dto.sku);
      if (existingVariantSku) {
        throw new ConflictException(`Variant with SKU "${dto.sku}" already exists`);
      }
      const existingItemSku = await this.repository.findItemBySku(businessId, dto.sku);
      if (existingItemSku) {
        throw new ConflictException(`SKU "${dto.sku}" is already used by an item`);
      }
    }

    const variant = await this.repository.createVariant({
      businessId,
      itemId,
      name: dto.name,
      sku: dto.sku ?? null,
      barcode: dto.barcode,
      price: dto.pricePaise != null ? paiseToDecimal(dto.pricePaise) : null,
      comparePrice: dto.comparePricePaise != null ? paiseToDecimal(dto.comparePricePaise) : null,
      attributes: dto.attributes as Prisma.InputJsonValue,
      stockQuantity: dto.stockQuantity,
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
      imageUrl: dto.imageUrl,
    });

    return this.mapVariantResponse(variant);
  }

  async updateVariant(
    businessId: string,
    itemId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ): Promise<VariantResponseDto> {
    const variant = await this.repository.findVariantById(businessId, variantId);
    if (!variant || variant.item_id !== itemId) {
      throw new NotFoundException(`Variant ${variantId} not found for item ${itemId}`);
    }

    // Validate SKU uniqueness if changing
    if (dto.sku && dto.sku !== variant.sku) {
      const existingVariantSku = await this.repository.findVariantBySku(businessId, dto.sku);
      if (existingVariantSku && existingVariantSku.id !== variantId) {
        throw new ConflictException(`Variant with SKU "${dto.sku}" already exists`);
      }
    }

    const updated = await this.repository.updateVariant(businessId, variantId, {
      name: dto.name,
      sku: dto.sku,
      barcode: dto.barcode,
      price: dto.pricePaise !== undefined
        ? (dto.pricePaise != null ? paiseToDecimal(dto.pricePaise) : null)
        : undefined,
      comparePrice: dto.comparePricePaise !== undefined
        ? (dto.comparePricePaise != null ? paiseToDecimal(dto.comparePricePaise) : null)
        : undefined,
      attributes: dto.attributes as Prisma.InputJsonValue | undefined,
      stockQuantity: dto.stockQuantity,
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
      imageUrl: dto.imageUrl,
    });

    return this.mapVariantResponse(updated);
  }

  async deleteVariant(
    businessId: string,
    itemId: string,
    variantId: string,
  ): Promise<void> {
    const variant = await this.repository.findVariantById(businessId, variantId);
    if (!variant || variant.item_id !== itemId) {
      throw new NotFoundException(`Variant ${variantId} not found for item ${itemId}`);
    }
    await this.repository.softDeleteVariant(businessId, variantId);
  }

  async listVariants(
    businessId: string,
    itemId: string,
  ): Promise<VariantResponseDto[]> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    const variants = await this.repository.listVariantsByItemId(businessId, itemId);
    return variants.map((v) => this.mapVariantResponse(v));
  }

  // ─────────────────────────────────────────────
  // PRICING
  // ─────────────────────────────────────────────

  async getEffectivePrice(
    businessId: string,
    itemId: string,
    variantId?: string,
    quantity: number = 1,
  ): Promise<EffectivePriceDto> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    // Determine base price: variant price overrides item price
    let basePriceDecimal = item.price;
    let resolvedVariantId: string | null = null;

    if (variantId) {
      const variant = item.variants.find((v) => v.id === variantId);
      if (!variant) {
        throw new NotFoundException(`Variant ${variantId} not found for item ${itemId}`);
      }
      // Variant price: null means inherit from parent item
      if (variant.price !== null) {
        basePriceDecimal = variant.price;
      }
      resolvedVariantId = variantId;
    }

    const basePricePaise = decimalToPaise(basePriceDecimal) ?? 0;
    // No pricing rules table in schema — final = base for now
    const finalPricePaise = basePricePaise;

    return {
      itemId,
      variantId: resolvedVariantId,
      basePricePaise,
      finalPricePaise,
      currency: item.currency,
      taxRate: new Prisma.Decimal(item.tax_rate).toNumber(),
      taxInclusive: item.tax_inclusive,
      comparePricePaise: decimalToPaise(item.compare_price),
      quantity,
      totalPaise: finalPricePaise * quantity,
    };
  }

  // ─────────────────────────────────────────────
  // STOCK
  // ─────────────────────────────────────────────

  async updateStock(
    businessId: string,
    itemId: string,
    dto: StockUpdateDto,
  ): Promise<StockLevelDto> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    // No-op if trackInventory is false
    if (!item.track_inventory) {
      this.logger.debug(
        `Stock update skipped for item ${itemId}: trackInventory=false`,
      );
      return this.buildStockLevel(item, dto.variantId ?? null);
    }

    let newStock: number;

    if (dto.variantId) {
      const variant = item.variants.find((v) => v.id === dto.variantId);
      if (!variant) {
        throw new NotFoundException(`Variant ${dto.variantId} not found for item ${itemId}`);
      }
      const updated = await this.repository.updateVariantStock(
        businessId,
        dto.variantId,
        dto.delta,
      );
      newStock = updated.stock_quantity ?? 0;
    } else {
      const updated = await this.repository.updateItemStock(businessId, itemId, dto.delta);
      newStock = updated.stock_quantity ?? 0;
    }

    // Check for low stock / out of stock events
    const threshold = item.low_stock_threshold ?? 0;

    if (newStock <= 0) {
      const event: CatalogStockOutEvent = {
        id: generateId(),
        type: 'catalog.stock.out',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        itemId,
        variantId: dto.variantId,
      };
      this.eventEmitter.emit('catalog.stock.out', event);
      this.logger.warn(
        `Stock out for item ${itemId}${dto.variantId ? ` variant ${dto.variantId}` : ''} (business: ${businessId})`,
      );
    } else if (threshold > 0 && newStock <= threshold) {
      const event: CatalogStockLowEvent = {
        id: generateId(),
        type: 'catalog.stock.low',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        itemId,
        variantId: dto.variantId,
        currentStock: newStock,
        threshold,
      };
      this.eventEmitter.emit('catalog.stock.low', event);
      this.logger.warn(
        `Low stock for item ${itemId}${dto.variantId ? ` variant ${dto.variantId}` : ''}: ${newStock} <= ${threshold}`,
      );
    }

    // Re-fetch to get fresh data for response
    const refreshed = await this.repository.findItemById(businessId, itemId);
    return this.buildStockLevel(refreshed!, dto.variantId ?? null);
  }

  async getStockLevel(
    businessId: string,
    itemId: string,
    variantId?: string,
  ): Promise<StockLevelDto> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    return this.buildStockLevel(item, variantId ?? null);
  }

  // ─────────────────────────────────────────────
  // EVENT LISTENERS
  // ─────────────────────────────────────────────

  /**
   * Decrement stock when an order is created.
   * Expects lineItems on the event payload.
   */
  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent & { lineItems?: OrderLineItem[] }): Promise<void> {
    this.logger.log(
      `Handling order.created for order ${event.orderId} (business: ${event.businessId})`,
    );

    try {
      const lineItems = event.lineItems;
      if (lineItems && Array.isArray(lineItems)) {
        for (const line of lineItems) {
          await this.decrementStockForLineItem(
            event.businessId,
            line.itemId,
            line.variantId,
            line.quantity,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to decrement stock for order ${event.orderId}: ${message}`,
      );
    }
  }

  /**
   * Restock when an order is cancelled.
   */
  @OnEvent('order.cancelled')
  async handleOrderCancelled(
    event: OrderCreatedEvent & { lineItems?: OrderLineItem[] },
  ): Promise<void> {
    this.logger.log(
      `Handling order.cancelled for order ${event.orderId} (business: ${event.businessId})`,
    );

    try {
      const lineItems = event.lineItems;
      if (lineItems && Array.isArray(lineItems)) {
        for (const line of lineItems) {
          await this.incrementStockForLineItem(
            event.businessId,
            line.itemId,
            line.variantId,
            line.quantity,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to restock for cancelled order ${event.orderId}: ${message}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────

  private async decrementStockForLineItem(
    businessId: string,
    itemId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item || !item.track_inventory) return;

    // Both stock writers return the updated row, so the post-decrement level is
    // already in hand — re-reading the item here cost a third query per line
    // item, on an event handler that runs once per line of every order.
    // `low_stock_threshold` is not touched by a stock write, so the value read
    // above is still current.
    const updated = variantId
      ? await this.repository.updateVariantStock(businessId, variantId, -quantity)
      : await this.repository.updateItemStock(businessId, itemId, -quantity);

    const stock = updated.stock_quantity ?? 0;
    const threshold = item.low_stock_threshold ?? 0;

    if (stock <= 0) {
      this.eventEmitter.emit('catalog.stock.out', {
        id: generateId(),
        type: 'catalog.stock.out',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        itemId,
        variantId,
      } satisfies CatalogStockOutEvent);
    } else if (threshold > 0 && stock <= threshold) {
      this.eventEmitter.emit('catalog.stock.low', {
        id: generateId(),
        type: 'catalog.stock.low',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        itemId,
        variantId,
        currentStock: stock,
        threshold,
      } satisfies CatalogStockLowEvent);
    }
  }

  private async incrementStockForLineItem(
    businessId: string,
    itemId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    const item = await this.repository.findItemById(businessId, itemId);
    if (!item || !item.track_inventory) return;

    if (variantId) {
      await this.repository.updateVariantStock(businessId, variantId, quantity);
    } else {
      await this.repository.updateItemStock(businessId, itemId, quantity);
    }
  }

  private generateAiDescription(
    name: string,
    description?: string | null,
    shortDescription?: string | null,
    tags?: string[],
  ): string {
    const parts = [name];
    if (shortDescription) parts.push(shortDescription);
    else if (description) parts.push(description.slice(0, 300));
    if (tags && tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);
    return parts.join('. ');
  }

  private buildStockLevel(
    item: {
      id: string;
      track_inventory: boolean;
      stock_quantity: number | null;
      low_stock_threshold: number | null;
      variants?: Array<{ id: string; stock_quantity: number | null }>;
    },
    variantId: string | null,
  ): StockLevelDto {
    if (!item.track_inventory) {
      return {
        itemId: item.id,
        variantId,
        stockQuantity: null,
        trackInventory: false,
        lowStockThreshold: null,
        isLowStock: false,
        isOutOfStock: false,
      };
    }

    let stock: number;
    if (variantId && item.variants) {
      const variant = item.variants.find((v) => v.id === variantId);
      stock = variant?.stock_quantity ?? 0;
    } else {
      stock = item.stock_quantity ?? 0;
    }

    const threshold = item.low_stock_threshold ?? 0;

    return {
      itemId: item.id,
      variantId,
      stockQuantity: stock,
      trackInventory: true,
      lowStockThreshold: item.low_stock_threshold,
      isLowStock: threshold > 0 && stock <= threshold && stock > 0,
      isOutOfStock: stock <= 0,
    };
  }

  private mapCategoryResponse(category: Record<string, unknown>): CategoryResponseDto {
    const children = category['children'] as Array<Record<string, unknown>> | undefined;
    return {
      id: category['id'] as string,
      businessId: category['business_id'] as string,
      parentId: (category['parent_id'] as string | null) ?? null,
      name: category['name'] as string,
      slug: category['slug'] as string,
      description: (category['description'] as string | null) ?? null,
      imageUrl: (category['image_url'] as string | null) ?? null,
      sortOrder: category['sort_order'] as number,
      isActive: category['is_active'] as boolean,
      createdAt: category['created_at'] as Date,
      updatedAt: category['updated_at'] as Date,
      children: children
        ? children.map((c) => this.mapCategoryResponse(c))
        : undefined,
    };
  }

  private mapItemResponse(item: Record<string, unknown>): ItemResponseDto {
    const category = item['category'] as Record<string, unknown> | null;
    const variants = item['variants'] as Array<Record<string, unknown>> | undefined;
    return {
      id: item['id'] as string,
      businessId: item['business_id'] as string,
      categoryId: (item['category_id'] as string | null) ?? null,
      type: item['type'] as string,
      name: item['name'] as string,
      slug: item['slug'] as string,
      description: (item['description'] as string | null) ?? null,
      shortDescription: (item['short_description'] as string | null) ?? null,
      pricePaise: decimalToPaise(item['price'] as Prisma.Decimal) ?? 0,
      comparePricePaise: decimalToPaise(item['compare_price'] as Prisma.Decimal | null),
      currency: item['currency'] as string,
      taxRate: new Prisma.Decimal(item['tax_rate'] as Prisma.Decimal).toNumber(),
      taxInclusive: item['tax_inclusive'] as boolean,
      sku: (item['sku'] as string | null) ?? null,
      barcode: (item['barcode'] as string | null) ?? null,
      stockQuantity: (item['stock_quantity'] as number | null) ?? null,
      trackInventory: item['track_inventory'] as boolean,
      allowBackorder: item['allow_backorder'] as boolean,
      lowStockThreshold: (item['low_stock_threshold'] as number | null) ?? null,
      weightGrams: (item['weight_grams'] as number | null) ?? null,
      images: (item['images'] as Array<{ url: string; alt?: string; isPrimary?: boolean }>) ?? [],
      tags: (item['tags'] as string[]) ?? [],
      aiDescription: (item['ai_description'] as string | null) ?? null,
      isActive: item['is_active'] as boolean,
      isFeatured: item['is_featured'] as boolean,
      sortOrder: item['sort_order'] as number,
      createdAt: item['created_at'] as Date,
      updatedAt: item['updated_at'] as Date,
      category: category ? this.mapCategoryResponse(category) : null,
      variants: variants
        ? variants.map((v) => this.mapVariantResponse(v))
        : undefined,
    };
  }

  private mapVariantResponse(variant: Record<string, unknown>): VariantResponseDto {
    return {
      id: variant['id'] as string,
      itemId: variant['item_id'] as string,
      name: variant['name'] as string,
      sku: (variant['sku'] as string | null) ?? null,
      barcode: (variant['barcode'] as string | null) ?? null,
      pricePaise: decimalToPaise(variant['price'] as Prisma.Decimal | null),
      comparePricePaise: decimalToPaise(variant['compare_price'] as Prisma.Decimal | null),
      attributes: (variant['attributes'] as Record<string, string>) ?? {},
      stockQuantity: (variant['stock_quantity'] as number | null) ?? null,
      isActive: variant['is_active'] as boolean,
      sortOrder: variant['sort_order'] as number,
      imageUrl: (variant['image_url'] as string | null) ?? null,
      createdAt: variant['created_at'] as Date,
      updatedAt: variant['updated_at'] as Date,
    };
  }
}
