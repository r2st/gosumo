import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CatalogItemType } from '@gosumo/shared';
import { SEARCH_TERM_MAX_LENGTH } from '../../../common/validators/search-term.constants';

// ─────────────────────────────────────────────
// CATEGORY DTOs
// ─────────────────────────────────────────────

export class CreateCategoryDto {
  @ApiProperty({ description: 'Category name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'URL-safe slug; auto-generated from name if omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ description: 'Parent category UUID for nesting' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Category description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Category image URL' })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Sort order (lower = first)', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Whether the category is active', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ description: 'Category name' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'URL-safe slug' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ description: 'Parent category UUID' })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ description: 'Category description' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: 'Category image URL' })
  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Sort order' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Whether the category is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─────────────────────────────────────────────
// ITEM DTOs
// ─────────────────────────────────────────────

export class CreateItemDto {
  @ApiProperty({ description: 'Item name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name!: string;

  @ApiPropertyOptional({ description: 'URL-safe slug; auto-generated from name if omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  slug?: string;

  @ApiPropertyOptional({ enum: CatalogItemType, description: 'Item type', default: 'PRODUCT' })
  @IsOptional()
  @IsEnum(CatalogItemType)
  type?: CatalogItemType;

  @ApiPropertyOptional({ description: 'Category UUID' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Item description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Short description (max 500 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string;

  @ApiProperty({ description: 'Price in paise (e.g. 10000 = Rs 100.00)' })
  @IsInt()
  @Min(0)
  pricePaise!: number;

  @ApiPropertyOptional({ description: 'Compare/MRP price in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  comparePricePaise?: number;

  @ApiPropertyOptional({ description: 'Currency code', default: 'INR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ description: 'Tax rate as decimal (e.g. 0.18 = 18% GST)', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  taxRate?: number;

  @ApiPropertyOptional({ description: 'Whether price includes tax', default: true })
  @IsOptional()
  @IsBoolean()
  taxInclusive?: boolean;

  @ApiPropertyOptional({ description: 'SKU code; auto-generated if omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @ApiPropertyOptional({ description: 'Barcode (EAN/UPC)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional({ description: 'Initial stock quantity' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @ApiPropertyOptional({ description: 'Whether to track inventory', default: false })
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional({ description: 'Allow orders when out of stock', default: false })
  @IsOptional()
  @IsBoolean()
  allowBackorder?: boolean;

  @ApiPropertyOptional({ description: 'Low stock threshold for alerts' })
  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;

  @ApiPropertyOptional({ description: 'Weight in grams' })
  @IsOptional()
  @IsInt()
  @Min(0)
  weightGrams?: number;

  @ApiPropertyOptional({ description: 'Image objects [{url, alt, isPrimary}]', type: 'array' })
  @IsOptional()
  @IsArray()
  images?: Array<{ url: string; alt?: string; isPrimary?: boolean }>;

  @ApiPropertyOptional({ description: 'Tags for filtering', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'AI-friendly description for RAG retrieval' })
  @IsOptional()
  @IsString()
  aiDescription?: string;

  @ApiPropertyOptional({ description: 'Whether the item is active', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Whether the item is featured', default: false })
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional({ description: 'Sort order' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateItemDto {
  @ApiPropertyOptional({ description: 'Item name' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional({ description: 'URL-safe slug' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  slug?: string;

  @ApiPropertyOptional({ enum: CatalogItemType })
  @IsOptional()
  @IsEnum(CatalogItemType)
  type?: CatalogItemType;

  @ApiPropertyOptional({ description: 'Category UUID' })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string | null;

  @ApiPropertyOptional({ description: 'Price in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePaise?: number;

  @ApiPropertyOptional({ description: 'Compare/MRP price in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  comparePricePaise?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ description: 'Tax rate as decimal' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  taxRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  taxInclusive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowBackorder?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  weightGrams?: number;

  @ApiPropertyOptional({ type: 'array' })
  @IsOptional()
  @IsArray()
  images?: Array<{ url: string; alt?: string; isPrimary?: boolean }>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  aiDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ItemQueryDto {
  @ApiPropertyOptional({ description: 'Search term for name/description/SKU' })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by category UUID' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: CatalogItemType })
  @IsOptional()
  @IsEnum(CatalogItemType)
  type?: CatalogItemType;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Filter by featured status' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional({ description: 'Filter by tags (comma-separated)' })
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// VARIANT DTOs
// ─────────────────────────────────────────────

export class CreateVariantDto {
  @ApiProperty({ description: 'Variant name (e.g. "Large / Red")' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Variant SKU; auto-generated if omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @ApiPropertyOptional({ description: 'Barcode' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional({ description: 'Price in paise (null = inherit from parent item)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePaise?: number | null;

  @ApiPropertyOptional({ description: 'Compare price in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  comparePricePaise?: number | null;

  @ApiPropertyOptional({ description: 'Variant attributes e.g. {size: "XL", color: "red"}' })
  @IsOptional()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Stock quantity for this variant' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @ApiPropertyOptional({ description: 'Whether the variant is active', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Sort order' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Variant image URL' })
  @IsOptional()
  @IsString()
  imageUrl?: string;
}

export class UpdateVariantDto {
  @ApiPropertyOptional({ description: 'Variant name' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional({ description: 'Price in paise (null = inherit from parent)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePaise?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  comparePricePaise?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  attributes?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string | null;
}

// ─────────────────────────────────────────────
// STOCK DTOs
// ─────────────────────────────────────────────

export class StockUpdateDto {
  @ApiProperty({ description: 'Stock change delta (positive to add, negative to subtract)' })
  @IsInt()
  delta!: number;

  @ApiPropertyOptional({ description: 'Variant UUID (if updating variant stock)' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional({ description: 'Reason for stock adjustment' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ─────────────────────────────────────────────
// RESPONSE DTOs
// ─────────────────────────────────────────────

export class CategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() businessId!: string;
  @ApiPropertyOptional() parentId?: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() imageUrl?: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ type: [CategoryResponseDto] })
  children?: CategoryResponseDto[];
}

export class VariantResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() itemId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() sku?: string | null;
  @ApiPropertyOptional() barcode?: string | null;
  @ApiPropertyOptional({ description: 'Price in paise (null = inherited from item)' })
  pricePaise?: number | null;
  @ApiPropertyOptional({ description: 'Compare price in paise' })
  comparePricePaise?: number | null;
  @ApiProperty() attributes!: Record<string, string>;
  @ApiPropertyOptional() stockQuantity?: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiPropertyOptional() imageUrl?: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class ItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() businessId!: string;
  @ApiPropertyOptional() categoryId?: string | null;
  @ApiProperty({ enum: CatalogItemType }) type!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() shortDescription?: string | null;
  @ApiProperty({ description: 'Price in paise' }) pricePaise!: number;
  @ApiPropertyOptional({ description: 'Compare price in paise' }) comparePricePaise?: number | null;
  @ApiProperty() currency!: string;
  @ApiProperty() taxRate!: number;
  @ApiProperty() taxInclusive!: boolean;
  @ApiPropertyOptional() sku?: string | null;
  @ApiPropertyOptional() barcode?: string | null;
  @ApiPropertyOptional() stockQuantity?: number | null;
  @ApiProperty() trackInventory!: boolean;
  @ApiProperty() allowBackorder!: boolean;
  @ApiPropertyOptional() lowStockThreshold?: number | null;
  @ApiPropertyOptional() weightGrams?: number | null;
  @ApiProperty() images!: Array<{ url: string; alt?: string; isPrimary?: boolean }>;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiPropertyOptional() aiDescription?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() isFeatured!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ type: CategoryResponseDto }) category?: CategoryResponseDto | null;
  @ApiPropertyOptional({ type: [VariantResponseDto] }) variants?: VariantResponseDto[];
}

export class StockLevelDto {
  @ApiProperty() itemId!: string;
  @ApiPropertyOptional() variantId?: string | null;
  @ApiPropertyOptional({ description: 'null when trackInventory=false' })
  stockQuantity!: number | null;
  @ApiProperty() trackInventory!: boolean;
  @ApiPropertyOptional() lowStockThreshold?: number | null;
  @ApiProperty() isLowStock!: boolean;
  @ApiProperty() isOutOfStock!: boolean;
}

export class EffectivePriceDto {
  @ApiProperty() itemId!: string;
  @ApiPropertyOptional() variantId?: string | null;
  @ApiProperty({ description: 'Base price in paise' }) basePricePaise!: number;
  @ApiProperty({ description: 'Final price in paise after rules' }) finalPricePaise!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() taxRate!: number;
  @ApiProperty() taxInclusive!: boolean;
  @ApiPropertyOptional({ description: 'Compare/MRP price in paise' }) comparePricePaise?: number | null;
  @ApiProperty({ description: 'Quantity used for price calculation' }) quantity!: number;
  @ApiProperty({ description: 'Total in paise (finalPricePaise * quantity)' }) totalPaise!: number;
}

export class PaginatedItemsResponseDto {
  @ApiProperty({ type: [ItemResponseDto] }) data!: ItemResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalPages!: number;
}
