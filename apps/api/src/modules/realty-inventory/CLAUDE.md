# Module: realty-inventory (GoSumo Realty)

The grounding layer — verified projects, units, and media assets. This is the **sole ground truth the AI may quote** (blueprint §14): the AI can only assert what a verified document contains, never model memory. Also hosts the BLTC→unit matcher.

## Public API (RealtyInventoryService)

```typescript
// Projects
createProject / getProject / listProjects / updateProject / deleteProject
// Units
createUnit / listUnits / updateUnit / setAvailability / deleteUnit
// Assets (auto-versioned; supersedes prior current asset)
publishAsset / listAssets
// Matching
match(businessId, criteria): Promise<UnitMatch[]>          // ad-hoc BLTC criteria
matchForLead(businessId, leadId, limit): Promise<UnitMatch[]>  // reads lead BLTC, records matched unit ids
```

## The 24-hour freshness rule (hard rule §14)

A unit is a match candidate only when `availability = AVAILABLE` **and** `verified_at` is within 24h. `setAvailability` (and creating a unit AVAILABLE) re-stamps `verified_at`. Stale units are excluded from matching, and `UnitResponseDto.isFresh` tells the caller whether the AI may assert availability — otherwise it must say "confirming".

## Matching (`unit-matching.util.ts`, pure + unit-tested)

Weights: config 40 · price 35 · locality 25. Exact config match, price within the budget band (partial credit up to 20% over), and locality overlap. Unspecified dimensions get neutral 50% credit; a fully-specified-and-mismatched unit scores 0 and is dropped.

## Events

**Emits:** `realty.project.created`, `realty.unit.availability_changed`, `realty.asset.published`.

## Tables owned

- `realty_projects` — verified fact sheet, RERA number, price band, `commission_terms` (**private, never surfaced to buyers**), `network_visibility` (gates exchange exposure).
- `realty_units` — config, prices, availability + `verified_at` freshness.
- `realty_assets` — versioned brochure/floorplan/pricesheet/video/pin; `is_current` prevents stale price-sheet leaks.

## Key gotchas

- **Money at the boundary:** prices stored as `Decimal(14,2)` rupees; exposed/accepted as integer paise.
- **An asset `url` is http/https only** (`CreateAssetDto`, ≤ `MAX_ASSET_URL_LENGTH`). The dashboard renders it as `<a href={asset.url}>Open</a>`, so a brochure published as `javascript:` is script running in a colleague's session — a STAFF member reaching an OWNER through a link the product told them to trust.
- **Depends on `realty-leads`** (imports `RealtyLeadsModule`) for `matchForLead`.
- **Soft delete only.**

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-inventory
```
