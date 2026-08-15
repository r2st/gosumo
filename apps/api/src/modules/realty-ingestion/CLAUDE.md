# Module: realty-ingestion (GoSumo Realty — Phase 4)

The **ingress for every external lead source** (blueprint §15). Parses source-specific payloads and hands normalized candidates to `RealtyLeadsService.ingestLead` for E.164 identity-merge. **Stateless — owns no table.**

## Sources

| Source | Entry point | Attribution |
|---|---|---|
| Meta Leadgen (FB/IG Lead Ads) | `POST /webhooks/realty/meta-leadgen` (@Public, HMAC) | `META_LEAD_AD`, sub_source = form/ad id |
| Portal enquiry email (99acres/MagicBricks/Housing) | `POST /webhooks/realty/portal-email` (@Public, shared secret) | `PORTAL`, sub_source = portal |
| CSV bulk import | `POST /realty/ingestion/csv` (auth) | `CSV` (or per-row), listing/campaign |
| CTWA (Click-to-WhatsApp) | `POST /realty/ingestion/ctwa` (auth) | `CTWA`, sub_source = ad headline, listing = landing url |

## Parsers (pure, unit-tested)

- `meta-leadgen.parser.ts` — `parseMetaLeadgen(payload)`: reads inline `field_data`, always surfaces `leadgen_id` for a later Graph fetch when the phone isn't inlined.
- `portal-email.parser.ts` — `parsePortalEmail(email)`: detects the portal from sender/subject, extracts name/phone/email/listing via label + regex; returns null with no phone.
- `csv-import.util.ts` — `parseCsvText` (quoted-field aware) + `normalizeCsvRows` (header aliases, E.164 validation, 1-based row errors).
- `ctwa.util.ts` — `parseCtwaReferral(input)`: turns a WhatsApp `referral` block into a candidate.

## Identity merge + attribution

All merge logic lives in `RealtyLeadsService.ingestLead` (one buyer, one history): normalize phone → find by phone → merge (fill only empty identity fields, append to `metadata.ingestHistory`) or create. Every path emits **`realty.lead.ingested`** with `{ source, subSource, listingRef, merged }`. Source ROI is fully derivable from the lead row + provenance trail.

## Security

- **Meta webhook:** `X-Hub-Signature-256` HMAC-SHA256 verified against `whatsapp.appSecret` (root rule #3). Invalid → log + discard, still 200 (no Meta retry storm).
- **Portal webhook:** `X-Portal-Token` shared secret (`realty.portalIngestToken`); mismatch → 401.
- `businessId` on webhooks comes from the `x-business-id` header set by the gateway (channel-adapter convention).

## Recovery (webhook DLQ)

All three webhooks answer 200 unconditionally, so **the provider never retries** — which makes `WebhookDlqService` (`webhook_dead_letters`) their only recovery path. Each controller route delegates to a capturing wrapper rather than owning a `try/catch`:

| Route | Wrapper | DLQ source |
|---|---|---|
| IVR callback | `RealtyIvrService.handleIvrDelivery` | `REALTY_IVR` |
| Meta Leadgen | `RealtyIngestionService.handleMetaLeadgenDelivery` | `REALTY_META_LEADGEN` |
| Portal email | `RealtyIngestionService.handlePortalEmailDelivery` | `REALTY_PORTAL_EMAIL` |

- **Transient vs permanent.** `summary.failed` (the ingest *threw*) is captured; `summary.skipped` (no phone, unparseable row) is not — retrying an identical body forever only fills the queue. Meta Leadgen captures on `failed > 0` as well as on a throw, because `ingestMetaLeadgen` reports per-candidate failures in a summary instead of raising.
- **`external_id`** is `sha256(body)` via `ingestDeliveryId()` — none of the three providers gives a usable delivery id, and `webhook_dead_letters` is unique on `(source, external_id)`.
- **Replay is safe to repeat**: `ingestLead` merges on the E.164 phone, so re-running a batch re-merges the leads that already landed.
- Captured payloads carry `{ businessId, body }`: `x-business-id` lives only on the original request, and a replay runs minutes later.

## Key gotchas

- **Webhooks answer 200 fast**; a failure is dead-lettered, never swallowed, and never thrown out of the handler.
- **De-dup is downstream** — a repeat phone (in a CSV or already in the DB) merges via `ingestLead`, it is not a CSV-level concern.
- Requires `rawBody: true` on `NestFactory.create` for HMAC (already set for channel-adapter).

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-ingestion
```
