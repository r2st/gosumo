-- 0033: index realty_leads(business_id, first_touch_at) for the nightly
-- intelligence aggregation.
--
-- The aggregation reads a tenant's leads over a rolling AGGREGATION_LOOKBACK_DAYS
-- (365) window. Until now it did that by paging the ordinary lead list — which
-- has no date filter — and discarding out-of-window rows in the application, so
-- the window never reached SQL and the cost tracked the tenant's all-time lead
-- count rather than the year being aggregated.
--
-- listForAggregation now filters `business_id = $1 AND first_touch_at >= $2` and
-- pages by keyset on (first_touch_at, id). None of the existing indexes can
-- serve that: the six on realty_leads lead with business_id but continue on
-- stage, temperature, assigned_agent_id, source or next_followup_at, so the
-- planner could seek to the tenant but then had to scan and sort all of its
-- leads. This index makes the window a range scan and supplies the keyset
-- ordering, so the last page costs what the first one does.
--
-- Applied by hand, per the convention set in 0032: this directory holds flat
-- SQL rather than Prisma migration directories, so `prisma migrate deploy`
-- finds nothing to apply.

CREATE INDEX IF NOT EXISTS "realty_leads_business_id_first_touch_at_idx"
  ON "realty_leads" ("business_id", "first_touch_at");
