# GoSumo Realty — Implementation Plan

> Derived from **GoSumo Realty Business Plan v1.docx** and **GoSumo Realty — Business Plan & Technical Blueprint.pptx** (v1.0, July 2026), mapped onto the existing GoSumo monorepo (NestJS 10 + Prisma + PostgreSQL + Next.js 14, Turborepo + pnpm).
>
> **Status:** living document. Phase 1 (Leads + Inventory grounding) is being implemented in this branch; later phases are specified here for continuity.

---

## 1. What GoSumo Realty is

GoSumo Realty is the **revenue operating system for Indian real-estate sales** — a WhatsApp-native AI workforce that answers every property lead in under 30 seconds, qualifies buyers on **B**udget–**L**ocation–**T**imeline–**C**onfiguration against the broker's live inventory, books site visits, follows up for 90 days, and — through a **co-broking exchange** — turns every unmatched lead into a shared closing.

Three compounding layers (from the plan):

| Layer | Effect | Product surface |
|---|---|---|
| **L0 — AI Lead Manager (SaaS)** | Full single-player value at n=1 | Leads, BLTC qualification, inventory grounding, site visits, cadences, broker console |
| **L1 — Micro-market intelligence** | Data network effect | Consented, anonymized corridor aggregates fed back into prompts |
| **L2 — Co-broking exchange** | Liquidity network effect | Syndications ledger, matching, reliability scores, settlement |
| **L3 — Developer inventory distribution** | Two-sided network effect | Developers publish verified inventory to the network |
| **L4 — Buyer trust mark** | Demand-side effect (slow burn) | Consumer-recognizable "Verified by GoSumo" standard |

The existing GoSumo platform is a general AI client-management system. Realty **reuses** its channel/conversation/message spine, AI engine (intent + confidence routing + guardrails + RAG), HITL approval queue, campaign engine, and analytics, and **adds** real-estate domain modules on top.

---

## 2. Architecture mapping (reuse vs. build)

| Realty capability (blueprint §) | Existing GoSumo asset to reuse | New work |
|---|---|---|
| WhatsApp ingest, normalize, threads | `channel-adapter`, `conversation`, `message` | CTWA/listing-context attachment, portal-email parser, Meta Leadgen |
| Read→Decide→Act, confidence routing, guardrails | `ai-engine` (`confidence-calculator`, `intent-classifier`, `guardrails`, `action-router`, RAG) | Realty intent set, **BLTC state machine**, grounded matching prompt, realty hard-rules |
| Site visits | `booking` (Google Calendar OAuth, reminders, reschedule) | `site_visits` domain object + realty reminder cadence |
| Follow-up / nurture | `campaign` | Declarative **cadence engine**, 12-template library, WhatsApp window/compliance gate |
| Human-in-the-loop / approval | `hitl` (tasks, review queue) | Hot-lead dossier, autonomy dial per account |
| Source ROI, funnel metrics | `analytics` | Realty North-Star metrics (visits/100 leads, etc.) |
| **Leads** (BLTC profile, attribution, stages, memory) | — | **New: `realty-leads` module** |
| **Projects / Units / Assets** grounding | partial analogy to `catalog` (kept separate) | **New: `realty-inventory` module** |
| **Co-broking exchange** (syndications, reliability, settlement) | — | **New: `realty-exchange` module (Phase 2)** |
| **Micro-market intelligence** aggregates | `analytics` events feed | **New: `realty-intelligence` module (Phase 2)** |

**Money convention:** follow the `catalog` precedent — store monetary amounts as Prisma `Decimal(14,2)` rupees (crore-scale safe), convert to/from **paise integers at the API boundary** (`rupeesToPaise` / `paiseToRupees`), honoring root rule #4.

**Multi-tenancy:** every table carries `business_id`; every repository query filters on it; RLS policies are the backstop (migration pattern per `0001_enable_rls.sql`).

---

## 3. Data model (new tables)

Naming follows the schema house style: snake_case columns, `@db.Uuid` PKs via `uuid_generate_v4()`, `@db.Timestamptz`, `created_at/updated_at/deleted_at`, `@@map`, and `business_id` on every tenant table.

### 3.1 `realty_leads` — the central entity (blueprint §14)
Identity & tenancy: `id, business_id, assigned_agent_id, whatsapp_phone (E.164, indexed), alt_phone, email, name, language_pref`
Attribution: `source, sub_source, campaign_id, listing_ref, first_touch_at`
Requirement (BLTC+): `budget_min, budget_max, localities[], timeline_months, config, purpose (END_USE/INVEST), financing (CASH/PREAPPROVED/NEEDS_LOAN)`
State: `qual_score (0–100), temperature (HOT/WARM/COLD/JUNK), stage (NEW→CONTACTED→QUALIFIED→VISIT_BOOKED→VISITED→NEGOTIATING→CLOSED_WON/CLOSED_LOST→DORMANT), matched_unit_ids[]`
Memory: `extracted_facts (JSONB), objections (JSONB), promises (JSONB)`
Compliance & network: `opt_out, consent_log (JSONB), share_consent, exchange_status`
Persistence: `cadence_id, cadence_step, next_followup_at`
Links: `client_id?`, `conversation_id?` (bridges to the existing messaging spine).

### 3.2 `realty_projects` — verified grounding (blueprint §14)
`id, business_id, name, developer, locality, geo (JSONB lat/lng), rera_number, possession_date, status (PRELAUNCH/UC/RTM), amenities (JSONB), price_band_min, price_band_max, fact_sheet_doc_id, commission_terms (JSONB, private — never reaches buyers), network_visibility (PRIVATE/EXCHANGE)`.

### 3.3 `realty_units`
`id, business_id, project_id, config (e.g. 2BHK), carpet_sqft, builtup_sqft, floor, facing, base_price, all_in_price, availability (AVAILABLE/HOLD/SOLD/UNVERIFIED), verified_at`.
**Hard rule:** `verified_at` staler than 24 h ⇒ the AI must answer "confirming" rather than assert availability.

### 3.4 `realty_assets`
`id, business_id, project_id, type (BROCHURE/FLOORPLAN/PRICESHEET/VIDEO/PIN), wa_media_id, url, version`. Pre-uploaded for instant WhatsApp sends; versioning prevents stale price-sheet leaks.

### 3.5 Phase-2 tables (specified, built later)
- `realty_site_visits` — `lead_id, project_id, unit_id?, scheduled_at, calendar_event_id, status (BOOKED/CONFIRMED/COMPLETED/NO_SHOW/RESCHEDULED), reminder_state, feedback, outcome`.
- `realty_cadences` / `realty_cadence_steps` — declarative sequences: `trigger (NO_RESPONSE/POST_VISIT/DORMANT), day_offset, template_id, condition, stop_on (REPLY/OPTOUT/STAGE_CHANGE)`.
- `realty_message_templates` — mirror of the WhatsApp template registry: `name, category (UTILITY/MARKETING), language, variables, approval_status` (sends blocked unless `APPROVED` and category-correct).
- `realty_syndications` — the immutable attribution ledger: `lead_id, from_business, to_business/developer, split_terms, buyer_consent_at, state (OFFERED→ACCEPTED→VISIT→CLOSED/EXPIRED/DISPUTED), commission_pool, platform_fee, settlement_state`.
- `realty_reliability_scores` — per-member composite gating exchange matching.
- `realty_intelligence_aggregates` — corridor pattern tables built only from consented tenants with minimum-n thresholds.
- `realty_resale_listings` — Tier-1 oxygen + exchange supply.

Enums added to Prisma **and** `@gosumo/shared/enums`: `LeadSource, LeadTemperature, LeadStage, LeadPurpose, FinancingStatus, ProjectStatus, UnitAvailability, NetworkVisibility, RealtyAssetType, ExchangeStatus, SyndicationState`.

---

## 4. Backend modules (controller → service → repository)

Each module follows the house pattern exactly: `*.module.ts`, `*.controller.ts` (`@TenantId()` + DTO validation, no logic), `*.service.ts` (logic + domain events via `EventEmitter2`), `*.repository.ts` (all Prisma, `business_id` scoped, soft-delete aware), `dto/index.ts` (class-validator + Swagger), `*.spec.ts` (Jest, repo + emitter mocked), `CLAUDE.md`.

### 4.1 `realty-leads` (Phase 1 — this branch)
**Public API:** `createLead`, `getLead`, `listLeads` (pipeline board, filters by stage/temperature/source/assignee), `updateLead`, `applyBltcUpdate` (merge BLTC slots, surface contradictions, never overwrite silently), `scoreLead` (weights: budget-fit 35 · timeline 25 · engagement 20 · financing 10 · purpose 10), `transitionStage`, `recordAttribution`, `captureMemory` (facts/objections/promises), `setOptOut`, `assignAgent`, `ingestFromConversation` (bridge from `message.received`).
**Emits:** `realty.lead.created`, `realty.lead.qualified`, `realty.lead.stage_changed`, `realty.lead.hot` (→ dossier alert), `realty.lead.opted_out`.
**Listens:** `message.received` (ingest/merge on E.164 phone), `booking.created`/site-visit events (→ VISIT_BOOKED).

### 4.2 `realty-inventory` (Phase 1 — this branch)
Projects + Units + Assets CRUD, plus a **matching service**: given a lead's BLTC profile, rank `AVAILABLE` units by fit (config match, price within budget band, locality overlap, freshness) and return the 1–3 best fits with their verified assets. This is the grounding source the AI may quote — **verified documents only, never model memory**.
**Emits:** `realty.project.created`, `realty.unit.availability_changed`, `realty.asset.published`.
**Guard:** `commission_terms` and any `PRIVATE`-visibility field are stripped from buyer-facing responses.

### 4.3 Phase-2 modules
`realty-sitevisits`, `realty-cadence`, `realty-exchange`, `realty-intelligence` (see §7 timeline).

---

## 5. AI engine extensions (blueprint §16)

Extend the existing `ai-engine` pipeline rather than fork it:
- **Realty intent set** (14 classes): `NEW_ENQUIRY, PRICE_INQUIRY, AVAILABILITY, SITE_VISIT, DOC_REQUEST, LOCATION_AMENITY, LOAN_QUERY, NEGOTIATION, LEGAL_RERA, SELLER_LEAD, RENTAL, REACTIVATION_REPLY, COMPLAINT_ABUSE` (+ default routing per class).
- **BLTC state machine** (`bltc-extractor.service.ts`): tracks UNKNOWN slots, asks ≤1 per turn, extracts opportunistically, never re-asks a filled slot, surfaces contradictions. Slot order adapts to entry point. 4/4 + reachable contact ⇒ QUALIFIED.
- **Grounded matching prompt**: assemble business identity → fact sheets for matched projects only → lead profile + BLTC → last 15 turns → RAG over playbook (pgvector/Qdrant) → calendar snapshot → template-window state → strict JSON contract (`response_text, confidence, intent, bltc_updates, stage_transition, actions[], escalation_reason?`).
- **Realty hard rules** in `guardrails.service.ts` (override any confidence score): no price absent from a verified sheet; no negotiation; no unverified availability (>24 h ⇒ "confirming"); no RERA/possession claims beyond sheet-verbatim; no loan/tax/investment advice; no messaging opted-out numbers; no cross-buyer disclosure. Every autonomous action → append-only `audit_logs`; per-account kill switch; autonomy dial.
- **Confidence** = Data Availability × 0.5 + Policy Clarity × 0.5; route ≥90 auto / 70–89 draft / 50–69 guided / <50 escalate (already modeled by `ConfidenceMode`).
- **Model routing:** fast/low-cost model for classification+extraction every message; frontier model for customer-facing turns; metered per lead.

---

## 6. Frontend (Next.js 14, `apps/web`)

New dashboard routes under `apps/web/src/app/(dashboard)/`:
- `leads/` — **pipeline board** (New → Qualified → Visit Booked → Visited → Negotiating → Closed), lead detail drawer with BLTC profile, transcript, memory (facts/objections/promises), source ROI.
- `leads/[leadId]/` — full lead view + matched units + activity.
- `inventory/` — projects list; `inventory/[projectId]/` — units + assets manager, availability + verified-at, RERA number, network visibility.
- `sitevisits/` (Phase 2), `exchange/` (Phase 2), `intelligence/` (Phase 2).
- Extend the WhatsApp-console notions: morning briefing card + hot-lead dossier surface on `dashboard/`.

Wiring: `apps/web/src/lib/api-client.ts` + a new `realty-types.ts`; components under `apps/web/src/components/leads/` and `components/inventory/`. Money via `lib/money.ts` (paise↔rupees, INR lakh/crore formatting).

---

## 7. Phased timeline (maps to blueprint §22 "8-week build")

| Phase | Weeks | Scope | Exit test |
|---|---|---|---|
| **P1 — Rails + core domain** *(this branch)* | Wk5–6 | Leads module, Inventory (projects/units/assets) + matching, shared contracts, schema + migration + RLS, unit tests, dashboard leads/inventory pages | Lead created & scored; BLTC merge + contradiction; unit match returns best fits; all new specs green |
| **P2 — AI loop + grounding** | Wk6–7 | Realty intent set, BLTC extractor, grounded matching prompt, realty hard rules | 20-turn scripted run, zero invented facts |
| **P3 — Site visits** | Wk7 | `realty_site_visits` on top of `booking`, reminders T-24h/T-2h, reschedule | End-to-end booking on a live calendar |
| **P4 — Ingestion** | Wk8 | Meta Leadgen webhook, portal email parser, CSV import + E.164 identity merge, CTWA context | A live portal test enquiry becomes a WhatsApp conversation unaided |
| **P5 — Cadences + compliance** | Wk9 | Cadence engine, 12-template registry, WhatsApp window/compliance gate, opt-out | D1/D3/D7 fires; opt-out kills all sends |
| **P6 — Broker surface** | Wk10 | Hot alerts, 7:30 briefing, approval queue, takeover protocol, PWA board | A pilot broker runs a full day phone-only |
| **P7 — Hardening** | Wk11 | Audit, retries/DLQ, rate limits, contradiction checks, chaos drills | 7-day unattended soak on shadow traffic |
| **P8 — Pilot migration** | Wk12 | Migrate pilot firms; autonomy dial opens on evidence | Launch-readiness gate (§24) passes |
| **Exchange (L2)** | Q3 | `realty-exchange`: syndications ledger, matching, consent gates, reliability scores, settlement; invitation-only white-glove | First 10 syndicated closings shepherded; dispute rate <2% |
| **Intelligence (L1)** | Q2–Q3 | `realty-intelligence`: nightly aggregates, corridor priors in prompts | Corridor priors live, opt-in >80% |

---

## 8. Security, privacy & compliance (blueprint §21)

- **Tenant isolation:** RLS on `business_id` everywhere; cross-tenant leakage is a full-stop defect.
- **DPDPA by architecture:** first-contact notice, purpose limitation, access/correction/erasure workflows, 24-month default retention → anonymize, processor terms (broker = fiduciary, GoSumo = processor).
- **WhatsApp hygiene:** category-correct templates enforced in code; instant opt-out; per-business number isolation; BSP fallback lane; quarterly fee-policy review.
- **RERA-safe:** RERA number on outbound where required; project claims sheet-verbatim; possession/approval always attributed.
- **Auditability:** append-only `audit_logs`; per-account kill switch; webhook HMAC verification on every ingress; encryption in transit and at rest.

---

## 9. KPIs / launch gates (blueprint §24)

Response P95 <60 s · engagement ≥40% · qualification ≥60% · **site visits/100 leads ≥8** (North Star) · show-up ≥60% · AI autonomy ≥70%→85% · hot-alert action <30 min ≥70% · logo churn <3.5%→<2.5%.
**No-ship if (any true):** a price stated absent from a verified sheet; availability affirmed for SOLD/HOLD/UNVERIFIED; a send to an opted-out number; a RERA claim beyond sheet-verbatim; hot alert >60 s in soak; any cross-tenant data appearance.

---

## 10. What is delivered in this branch (Phase 1)

1. This plan (`docs/implementation-plan.md`).
2. Shared contracts: realty enums + domain events + BLTC interfaces in `@gosumo/shared`.
3. Prisma schema: `realty_leads`, `realty_projects`, `realty_units`, `realty_assets` + enums; hand-written SQL migration with RLS + audit triggers.
4. `realty-leads` NestJS module (controller/service/repository/dto/spec + CLAUDE.md).
5. `realty-inventory` NestJS module (controller/service/repository/dto/spec + CLAUDE.md), incl. BLTC→unit matching.
6. Module registration in `app.module.ts`.
7. `apps/web` leads pipeline page + inventory page + API/types wiring.
8. Unit tests for all new services.
