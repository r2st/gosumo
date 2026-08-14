-- Migration: 0032_add_cross_tenant_lookup_indexes
-- Index the lookups that run before a tenant is known.
--
-- Almost every index in this schema leads with `business_id`, which is correct
-- for the tenant-scoped queries that make up most of the API. A handful of
-- lookups cannot supply a business_id at all — they are the queries that
-- *establish* which tenant a request belongs to — and none of them could seek
-- on a business_id-leading index, so each was a sequential scan:
--
--   team_members(email)                     every login and every failed login
--   channel_accounts(channel, external_id)  every inbound message, all channels
--   payments(payment_link_id)               payment-link webhooks
--   refunds(gateway_refund_id)              refund webhooks
--   realty_eoi_requests(payment_link_id)    Razorpay EOI webhooks
--   realty_cadence_enrollments(status, next_run_at)
--                                           the scheduler's global tick, which
--                                           calls findDueEnrollments with no
--                                           businessId and take: 500
--
-- The first two are the hot ones: they sit on the login path and the inbound
-- message path respectively, so their cost grew with total row count across all
-- tenants rather than with any one tenant's data.
--
-- Deliberately not added:
--   businesses(intelligence_opt_in)   one row per tenant; a scan is cheaper
--                                     than maintaining the index
--   realty_dead_letters(status)       countPendingGlobal is a rare ops metric
--
-- These are plain CREATE INDEX statements, matching every migration before
-- this one. At current table sizes they complete in milliseconds. Once
-- payments or team_members are large enough for the SHARE lock to matter,
-- run them as CREATE INDEX CONCURRENTLY instead — that form cannot run inside
-- a transaction, so it must be issued outside any wrapping BEGIN/COMMIT.

-- Login: resolve a member by email across all tenants. The existing
-- @@unique([business_id, email]) cannot serve this — email is not its leading
-- column.
CREATE INDEX IF NOT EXISTS "idx_team_members_email"
    ON "team_members"("email");

-- Inbound webhooks: the provider sends a channel type and its own external id
-- and nothing else. The row this finds is what establishes the tenant, so
-- neither channel_accounts index (both business_id-leading) applies.
CREATE INDEX IF NOT EXISTS "idx_channel_accounts_channel_external"
    ON "channel_accounts"("channel", "external_id");

-- Payment-link and refund webhooks arrive with only the gateway's own id.
CREATE INDEX IF NOT EXISTS "idx_payments_payment_link_id"
    ON "payments"("payment_link_id");

CREATE INDEX IF NOT EXISTS "idx_refunds_gateway_refund_id"
    ON "refunds"("gateway_refund_id");

CREATE INDEX IF NOT EXISTS "idx_realty_eoi_requests_payment_link_id"
    ON "realty_eoi_requests"("payment_link_id");

-- Cadence scheduler: findDueEnrollments(now) with no businessId sweeps every
-- tenant's due enrollments, ordered by next_run_at. Putting next_run_at second
-- lets the index satisfy both the filter and the ordering.
CREATE INDEX IF NOT EXISTS "idx_realty_cadence_enrollments_status_next_run"
    ON "realty_cadence_enrollments"("status", "next_run_at");
