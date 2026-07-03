# Module: ai-engine/realty (GoSumo Realty — AI loop)

Phase 2 of GoSumo Realty: the grounded AI loop layered on top of the general `ai-engine`. Classifies the 14 realty intents, qualifies the buyer on BLTC, grounds every reply in verified inventory, enforces the realty hard rules, and routes by a 0–100 confidence score. The loop never invents facts — anything it cannot ground blocks an autonomous send and hands off to a human.

## Pipeline (RealtyAiService.processTurn)

READ → classify intent · extract BLTC · load lead + verified inventory grounding.
DECIDE → assemble the grounded prompt · generate · parse · run realty hard rules · score confidence.
ACT → persist BLTC (via `realty-leads`) · write every decision to append-only `audit_logs` · route AUTO / DRAFT / GUIDED / ESCALATE.

## Pieces

- `realty-intent-classifier.service.ts` — 14 intents (`RealtyIntent`), Tier-1 Hinglish rules → Tier-3 LLM. Each result carries its `RealtyRoutePolicy` (autonomy ceiling).
- `bltc-extractor.service.ts` + `bltc-extraction.util.ts` — deterministic BLTC lifting + the one-question state machine: tracks UNKNOWN slots, asks ≤1/turn, extracts opportunistically, never re-asks a filled slot, surfaces contradictions (never silent overwrite), slot order adapts to the entry intent. 4/4 core BLTC + reachable ⇒ QUALIFIED.
- `realty-prompt.ts` — grounded prompt in blueprint §16 order: business identity → matched fact sheets ONLY → lead+BLTC → last 15 turns → playbook (RAG) → calendar → template window → strict JSON contract.
- `realty-guardrails.service.ts` — the hard rules (override any score): no unverified price, no negotiation, no stale availability (>24h ⇒ "confirming"), no RERA/possession beyond sheet, no loan/tax/investment advice, no opted-out sends, no cross-buyer disclosure.
- `realty-confidence.util.ts` — `finalScore = data×0.5 + policy×0.5` (0–100); ≥90 AUTO · 70–89 DRAFT · 50–69 GUIDED · <50 ESCALATE. Intent policy + guardrail violations cap the band down.
- `realty-response.parser.ts` — parses the strict `RealtyGroundedResponse` JSON contract defensively.
- `realty-audit.service.ts` — one append-only `audit_logs` row per decision (`actor_type: AI`).

## Grounding rule

The AI may quote ONLY what is in `<verified_fact_sheets>` (matched projects/units from `realty-inventory`, `commission_terms`/PRIVATE fields stripped by the caller). A quoted price not within tolerance of a verified figure ⇒ `unverified_price` ⇒ escalate. A unit not verified within 24h ⇒ answer "confirming".

## Events

**Emits:** `realty.ai.turn_completed` (lightweight, non-durable). BLTC persistence via `realty-leads` still emits `realty.lead.qualified` / `.hot` / `.stage_changed`.

## Reuses

- `LlmClientService` (Claude) + `GuardrailsService` (jailbreak/PII) from the base `ai-engine` (provided locally — both stateless).
- `RealtyLeadsService` (BLTC merge + qualification) and `RealtyInventoryService` (BLTC→unit matching + fact sheets).

## Test

```bash
pnpm --filter @gosumo/api exec jest --testPathPattern modules/ai-engine/realty
```

## Key gotchas

- **Money at the boundary:** all prices are integer paise inside the loop; `realty-leads`/`realty-inventory` convert to/from `Decimal` rupees.
- **Intent policy is a ceiling, not a floor:** `PRICE_INQUIRY` is DRAFT_ONLY (never auto), `NEGOTIATION`/`LOAN_QUERY`/`LEGAL_RERA`/`SELLER_LEAD`/`COMPLAINT_ABUSE` are always ESCALATE.
- **Guardrails are pure** and run on the *proposed* response — the orchestrator turns a BLOCK into an escalation and a REWRITE into a "confirming" reply.
