# Module: realty-exchange (GoSumo Realty)

The **L2 co-broking exchange** (blueprint §19). Formalises India's informal 50:50
deal-sharing culture into a trustable liquidity network: every qualified lead a
broker can't match to their own inventory becomes a shared closing with another
member. The trust anchor is an immutable syndication ledger plus a reliability
score that gates and ranks who you route deals to.

## Public API (RealtyExchangeService)

```typescript
// Syndication state machine (OFFERED → ACCEPTED → VISIT → CLOSED | EXPIRED | DISPUTED)
createSyndication(fromBusinessId, dto)          // buyer-consent gated; split must sum to 100
acceptSyndication / recordVisit / closeSyndication / expireSyndication / disputeSyndication
rateSyndication(id, ratingBusinessId, ratings)  // post-deal rating → recomputes counterparty score
// Matching + reliability
matchLeadToExchange(businessId, leadId, opts)   // network supply ranked by fit × reliability
calculateReliabilityScore(targetBusinessId)     // composite; upserts the member's self-row
listReliabilityScores(businessId)
// Resale supply CRUD
createResaleListing / listResaleListings / getResaleListing / updateResaleListing / deleteResaleListing
```

## The consent gate (hard rule)

`createSyndication` reads the lead in the originator's tenant scope and refuses
(`403`) unless `lead.shareConsent` is true — a buyer's lead never crosses the
network without their explicit agreement. `buyer_consent_at` is stamped at offer.

## Platform fee

`closeSyndication` books the commission pool and takes a platform fee of **5–8 %**
(`DEFAULT_PLATFORM_FEE_RATE = 0.06`, clamped to `[0.05, 0.08]`), then moves
`settlement_state` to PENDING. A dispute flips it to REVERSED.

## Matching (`exchange-matching.util.ts`, pure + unit-tested)

Fit weights mirror the inventory matcher (config 40 · price 35 · locality 25) so
scores are comparable. The ranking key blends fit with counterparty reliability:
`blended = fit·0.7 + reliability·0.3`. Fully-specified hard mismatches score 0 and
drop out. Optionally attaches an OpenRouter-written rationale (best-effort, never
blocks — degrades to `null`).

## Reliability (`reliability-scoring.util.ts`, pure + unit-tested)

Composite of four sub-scores (weights sum to 100): response speed 25 · show-up
integrity 25 · **split honoring 30** (dominant — the behaviour the exchange exists
to police) · documentation hygiene 20. Dimensions with no evidence get a neutral
50, so a brand-new member is trusted enough to match but can't outrank proven
partners. Signals come from ratings stored on syndications, keyed by the *rated*
party; a member's canonical score is a self-row (`business_id == target_business_id`).

## Cross-tenant reads (intentional)

Two repository reads deliberately cross tenants — this is what makes the network
liquid, and they are the only such reads here:
- **Exchange supply:** other members' `status=ACTIVE` resale listings +
  `network_visibility=EXCHANGE`, `availability=AVAILABLE` units (`business_id != requester`).
- **Reliability aggregation:** every syndication a member is party to on either
  side (scoped by the member's own id, not the tenant column).

`seller_phone` on a resale listing is PRIVATE and never leaves the owner; the
exchange matcher never carries it. The DB backs this with a second permissive
SELECT policy that only exposes ACTIVE, non-deleted resale rows network-wide.

## Events

**Emits:** `realty.syndication.offered`, `realty.syndication.accepted`,
`realty.syndication.closed`, `realty.syndication.disputed`.

## Tables owned

- `realty_syndications` — immutable attribution ledger. A BEFORE-UPDATE trigger
  freezes attribution columns (lead, from/to/developer, split, consent, created_at);
  only `state`, `settlement_state`, and the money legs advance.
- `realty_reliability_scores` — per-member composite; unique on
  `(business_id, target_business_id, period_start)`, one row per member per month.
- `realty_resale_listings` — Tier-1 oxygen + exchange supply.

## Key gotchas

- **Money at the boundary:** `Decimal(14,2)` rupees in the DB; integer paise in/out.
- **Depends on `realty-leads`** for `getLead` (consent + BLTC).
- **Soft delete only** for syndications and resale listings.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-exchange
```
