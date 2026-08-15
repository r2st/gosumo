import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { CatalogService } from './catalog.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateItemDto,
  UpdateItemDto,
  ItemQueryDto,
  SearchItemsQueryDto,
  EffectivePriceQueryDto,
  CreateVariantDto,
  UpdateVariantDto,
  StockUpdateDto,
} from './dto';

/**
 * CatalogController — REST endpoints for catalog management.
 *
 * All routes are protected by JwtAuthGuard (applied globally).
 * The @TenantId() decorator extracts the businessId from the
 * JWT-populated request context.
 *
 * Routes:
 *   Categories: /catalog/categories
 *   Items:      /catalog/items
 *   Variants:   /catalog/items/:itemId/variants
 *   Stock:      /catalog/items/:itemId/stock
 *   Price:      /catalog/items/:itemId/price
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  private readonly logger = new Logger(CatalogController.name);

  constructor(private readonly catalogService: CatalogService) {}

  // ─────────────────────────────────────────────
  // CATEGORIES
  // ─────────────────────────────────────────────

  @Post('categories')
  @ApiOperation({ summary: 'Create a catalog category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  @ApiResponse({ status: 404, description: 'Parent category not found' })
  @ApiResponse({ status: 409, description: 'Slug conflict' })
  async createCategory(
    @TenantId() tenantId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.catalogService.createCategory(tenantId, dto);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List categories (optionally filtered by parentId)' })
  @ApiQuery({ name: 'parentId', required: false, description: 'Filter by parent category UUID; pass "null" for root categories' })
  @ApiResponse({ status: 200, description: 'List of categories' })
  async listCategories(
    @TenantId() tenantId: string,
    @Query('parentId') parentId?: string,
  ) {
    const resolvedParentId = parentId === 'null' ? null : parentId;
    return this.catalogService.listCategories(tenantId, resolvedParentId);
  }

  @Get('categories/:id')
  @ApiOperation({ summary: 'Get a single category by ID' })
  @ApiParam({ name: 'id', description: 'Category UUID' })
  @ApiResponse({ status: 200, description: 'Category details' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async getCategory(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.catalogService.getCategory(tenantId, id);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update a catalog category' })
  @ApiParam({ name: 'id', description: 'Category UUID' })
  @ApiResponse({ status: 200, description: 'Category updated' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async updateCategory(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.catalogService.updateCategory(tenantId, id, dto);
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a catalog category' })
  @ApiParam({ name: 'id', description: 'Category UUID' })
  @ApiResponse({ status: 204, description: 'Category deleted' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  @ApiResponse({ status: 422, description: 'Category has active items' })
  async deleteCategory(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.catalogService.deleteCategory(tenantId, id);
  }

  // ─────────────────────────────────────────────
  // ITEMS
  // ─────────────────────────────────────────────

  @Post('items')
  @ApiOperation({ summary: 'Create a catalog item' })
  @ApiResponse({ status: 201, description: 'Item created' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  @ApiResponse({ status: 409, description: 'SKU or slug conflict' })
  async createItem(
    @TenantId() tenantId: string,
    @Body() dto: CreateItemDto,
  ) {
    return this.catalogService.createItem(tenantId, dto);
  }

  @Get('items')
  @ApiOperation({ summary: 'List items with filters and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated list of items' })
  async listItems(
    @TenantId() tenantId: string,
    @Query() query: ItemQueryDto,
  ) {
    return this.catalogService.listItems(tenantId, query);
  }

  @Get('items/search')
  @ApiOperation({ summary: 'Search catalog items by name, description, or SKU' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max results', type: Number })
  @ApiResponse({ status: 200, description: 'Matching items' })
  async searchItems(@TenantId() tenantId: string, @Query() query: SearchItemsQueryDto) {
    return this.catalogService.searchCatalog(tenantId, query.q, query.limit);
  }

  @Get('items/:id')
  @ApiOperation({ summary: 'Get a single item by ID' })
  @ApiParam({ name: 'id', description: 'Item UUID' })
  @ApiResponse({ status: 200, description: 'Item details with variants' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  async getItem(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.catalogService.getItem(tenantId, id);
  }

  @Patch('items/:id')
  @ApiOperation({ summary: 'Update a catalog item' })
  @ApiParam({ name: 'id', description: 'Item UUID' })
  @ApiResponse({ status: 200, description: 'Item updated' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  @ApiResponse({ status: 409, description: 'SKU or slug conflict' })
  async updateItem(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.catalogService.updateItem(tenantId, id, dto);
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a catalog item' })
  @ApiParam({ name: 'id', description: 'Item UUID' })
  @ApiResponse({ status: 204, description: 'Item deleted' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  async deleteItem(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.catalogService.deleteItem(tenantId, id);
  }

  // ─────────────────────────────────────────────
  // VARIANTS
  // ─────────────────────────────────────────────

  @Post('items/:itemId/variants')
  @ApiOperation({ summary: 'Add a variant to a catalog item' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiResponse({ status: 201, description: 'Variant created' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  @ApiResponse({ status: 409, description: 'SKU conflict' })
  async addVariant(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.catalogService.addVariant(tenantId, itemId, dto);
  }

  @Get('items/:itemId/variants')
  @ApiOperation({ summary: 'List variants for an item' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiResponse({ status: 200, description: 'List of variants' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  async listVariants(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
  ) {
    return this.catalogService.listVariants(tenantId, itemId);
  }

  @Patch('items/:itemId/variants/:variantId')
  @ApiOperation({ summary: 'Update a variant' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiParam({ name: 'variantId', description: 'Variant UUID' })
  @ApiResponse({ status: 200, description: 'Variant updated' })
  @ApiResponse({ status: 404, description: 'Variant not found' })
  async updateVariant(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Param('variantId', UuidValidationPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.catalogService.updateVariant(tenantId, itemId, variantId, dto);
  }

  @Delete('items/:itemId/variants/:variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a variant' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiParam({ name: 'variantId', description: 'Variant UUID' })
  @ApiResponse({ status: 204, description: 'Variant deleted' })
  @ApiResponse({ status: 404, description: 'Variant not found' })
  async deleteVariant(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Param('variantId', UuidValidationPipe) variantId: string,
  ) {
    await this.catalogService.deleteVariant(tenantId, itemId, variantId);
  }

  // ─────────────────────────────────────────────
  // STOCK
  // ─────────────────────────────────────────────

  @Get('items/:itemId/stock')
  @ApiOperation({ summary: 'Get stock level for an item' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiQuery({ name: 'variantId', required: false, description: 'Variant UUID' })
  @ApiResponse({ status: 200, description: 'Stock level' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  async getStockLevel(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Query('variantId') variantId?: string,
  ) {
    return this.catalogService.getStockLevel(tenantId, itemId, variantId);
  }

  @Patch('items/:itemId/stock')
  @ApiOperation({ summary: 'Update stock level (increment/decrement)' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiResponse({ status: 200, description: 'Updated stock level' })
  @ApiResponse({ status: 404, description: 'Item or variant not found' })
  async updateStock(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Body() dto: StockUpdateDto,
  ) {
    return this.catalogService.updateStock(tenantId, itemId, dto);
  }

  // ─────────────────────────────────────────────
  // PRICING
  // ─────────────────────────────────────────────

  @Get('items/:itemId/price')
  @ApiOperation({ summary: 'Get effective price for an item/variant' })
  @ApiParam({ name: 'itemId', description: 'Item UUID' })
  @ApiQuery({ name: 'variantId', required: false, description: 'Variant UUID' })
  @ApiQuery({ name: 'quantity', required: false, description: 'Quantity for total calculation', type: Number })
  @ApiResponse({ status: 200, description: 'Effective price breakdown' })
  @ApiResponse({ status: 404, description: 'Item or variant not found' })
  async getEffectivePrice(
    @TenantId() tenantId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Query() query: EffectivePriceQueryDto,
  ) {
    // Read through the DTO, never `parseInt` on a raw @Query() string: this
    // quantity multiplies money, and NaN / negative / fractional values all
    // used to reach the arithmetic. See EffectivePriceQueryDto.
    return this.catalogService.getEffectivePrice(
      tenantId,
      itemId,
      query.variantId,
      query.quantity ?? 1,
    );
  }
}
