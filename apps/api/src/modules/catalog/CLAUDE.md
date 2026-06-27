# Module: catalog

Manages a business's products and services — the things customers can buy, book, or inquire about. The primary data source the AI reads when answering pricing and availability questions.

## Purpose

Maintain an accurate, searchable product/service catalog with categories, items, variants, packages, pricing rules, and inventory tracking. The AI must query this module to answer any pricing question — it must never guess or invent prices.

## Public API (ICatalogService)

```typescript
// Categories
createCategory / updateCategory / deleteCategory / listCategories

// Items
createItem / updateItem / deleteItem / getItem
listItems(businessId, query): Promise<PaginatedResult<CatalogItemDto>>
searchCatalog(businessId, query, limit?): Promise<CatalogItemDto[]>

// Variants
addVariant / updateVariant / deleteVariant

// Packages
createPackage / updatePackage / deletePackage / listPackages

// Pricing
getEffectivePrice(businessId, itemId, variantId?, quantity?): Promise<EffectivePriceDto>
createPricingRule / updatePricingRule / deletePricingRule

// Inventory
updateStock(businessId, itemId, variantId, delta): Promise<void>
getStockLevel(businessId, itemId, variantId?): Promise<StockLevelDto>
```

## Events

**Emits:**
- `catalog.item.created` — `{ businessId, itemId, sku, categoryId }`
- `catalog.item.updated` — `{ businessId, itemId, changedFields }`
- `catalog.stock.low` — `{ businessId, itemId, variantId, currentStock, threshold }`
- `catalog.stock.out` — `{ businessId, itemId, variantId }`

**Listens to:**
- `order.created` — decrement stock for ordered items
- `order.cancelled` — restock cancelled items

## Tables Owned

- `catalog_categories` — tree structure via `parent_id` self-reference
- `catalog_items` — base item with pricing, inventory, media, AI description
- `catalog_variants` — size/color variants with optional price override
- `catalog_packages` — bundles of multiple items at a package price

## Dependencies

- `@gosumo/shared` — currency utils (`paiseToRupees`), tenant isolation
- `@gosumo/tenant` — `validateBusinessId()`

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/catalog
```

## Key Gotchas

- **All prices stored as `Decimal(12,2)` in the schema** (rupees, not paise) — the Prisma schema uses Decimal; convert to/from paise only at the API boundary using `@gosumo/shared` currency utils
- **SKU must be unique per business** — auto-generate if not provided (`generateSKU()` from `@gosumo/shared`)
- **Pricing rule priority:** ITEM > CATEGORY > GLOBAL. Multiple rules of the same scope stack additively up to the business's configured discount cap
- **Soft delete only** — `deleted_at` timestamp; never hard-delete items because orders reference them by `itemId`
- **`trackInventory: false`** → `updateStock()` is a no-op; `getStockLevel()` returns `null`
- **Delete category with active items → 422** error; deactivate items first
- **`ai_description`** field on `catalog_items` is a plain-English description optimized for RAG retrieval; populate it when creating or updating items — it is indexed in Qdrant via `vector_embeddings_metadata`
- Variant price: `null` means inherit from parent item; an explicit value (even ₹0) overrides the parent
