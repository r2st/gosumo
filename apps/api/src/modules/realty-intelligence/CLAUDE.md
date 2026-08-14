# Module: realty-intelligence (GoSumo Realty — L1, blueprint §18)

The **micro-market intelligence** layer — the data network effect. Builds consented,
anonymized **corridor aggregates** nightly and feeds them back into the grounded AI
prompt as *priors*, so every opted-in broker's AI gets smarter as the network grows.
Full value only appears with scale; a single broker still gets their own source-ROI
report at n=1.

## Public API (RealtyIntelligenceService)

```typescript
generateNightlyAggregates(now?, businessId?)      // the scheduler tick — rebuild aggregates
getCorridorPriors(businessId, corridor, metricTypes?)  // latest aggregate per metric
buildCorridorContext(businessId, corridor)        // → the <micro_market_intelligence> prompt section (or null)
getCorridorNarrative(businessId, corridor)        // best-effort one-line LLM summary (free OpenRouter model)
getSourceQualityReport(businessId)                // per-source ROI over the tenant's own leads
listAggregates(businessId, { corridor?, metricType? })
listCorridors(businessId)
getOptInStatus / optIn / optOut                   // consent management
```

## The five corridor metrics (`IntelligenceMetricType`)

A **corridor** = a locality/sub-market key. A lead attributes to **every** locality it
named. `metric_value` is a metric-specific JSONB payload (`intelligence-aggregation.util.ts`):

| Metric | What it captures |
|---|---|
| `CADENCE_CONVERSION` | conversion rate + when conversions land (SAME_DAY…LATER buckets) — which follow-up timing works |
| `OBJECTION_FREQUENCY` | recurring objection categories, corridor-wide + by config (project-type proxy) |
| `PRICE_ELASTICITY` | budget-band quantiles (p25/p50/p75) + a recommended anchor band, by locality |
| `SOURCE_QUALITY` | per-source qualified-rate, visit-rate, avg score — downstream lead quality |
| `SEASONAL_VELOCITY` | lead inflow + conversion by month |

## Consent + anti-reconstruction (DPDPA by architecture)

- **Opt-in only.** `businesses.intelligence_opt_in` defaults **false**; the nightly run
  reads leads ONLY from opted-in tenants (`listOptInBusinessIds`).
- **Minimum-n threshold** (default **5**): a corridor is only aggregated when it has ≥ n
  leads; named sub-groups (a lead source, an objection label) are only surfaced when that
  sub-group itself has ≥ n. Rates/quantiles over the whole corridor are safe; naming a rare
  attribute is not. Below n ⇒ suppressed entirely.
- Aggregates are **summary statistics only** — never raw rows.

## AI grounding rule (critical)

`buildCorridorContext` renders a `<micro_market_intelligence>` section that is injected into
the realty grounded prompt (`ai-engine/realty/realty-prompt.ts`) when the lead's primary
locality has data. These are **statistical priors, NOT verified facts** — the section and a
hard rule both forbid the AI from quoting the numbers to the buyer. Only `<verified_fact_sheets>`
remain quotable, preserving the no-invented-facts guarantee. The realty AI loop injects
`RealtyIntelligenceService` with `@Optional()`; absent it, the section is simply omitted.

## Scheduling

Registers one **repeatable** BullMQ job on the `realty-intelligence` queue (cron `0 21 * * *`
= 02:30 IST) with a stable `jobId`, so redeploys never stack duplicate schedules. A missed
run just leaves yesterday's priors in place (non-fatal).

## Events

**Emits:** `realty.intelligence.aggregates_generated`, `realty.intelligence.opted_in`,
`realty.intelligence.opted_out`.

## Tables owned

`realty_intelligence_aggregates` — `(business_id, corridor, metric_type, period_start)` unique;
`metric_value` JSONB, `sample_size`, `min_n_threshold`, `period_*`. RLS on `business_id`.

## Cross-module reads

Uses `RealtyLeadsService.listLeadsForAggregation` (public API — never touches the leads table
directly) to stream leads for aggregation, and `LlmClientService` (OpenRouter free-tier, provided
locally) for the optional narration. `intelligence_opt_in` on `businesses` is read/written here.

That method — **not** `listLeads` — exists for this caller: it pushes the lookback window into
the WHERE clause, projects only the ten columns the maths reads, and pages by keyset. Reading
the ordinary lead list instead meant fetching every lead the tenant had ever had, in full, and
discarding the out-of-window rows in JavaScript. `LEAD_FETCH_CAP` bounds the walk; hitting it is
logged as a warning, because the resulting aggregates would be a biased sample of the oldest
leads rather than the corridor.

## Key gotchas

- **Money at the boundary:** budgets arrive as integer paise from the leads service; the
  price-band payload stays in paise (formatted to lakh/crore only in the prompt/UI).
- **The aggregator uses the leads service, not SQL** — keeps the module boundary clean and the
  math unit-testable (`intelligence-aggregation.util.ts` is pure + fully covered).
- **Own-business reports skip min-n** (`getSourceQualityReport` passes minN=1) — a broker seeing
  their own data has no reconstruction risk; the network-shared aggregates always enforce it.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-intelligence
```
