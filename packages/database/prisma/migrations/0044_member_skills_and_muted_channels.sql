-- Migration: 0044_member_skills_and_muted_channels
-- Two additive columns: routing skills on team members, and per-channel
-- muting on the operator notification settings added in 0043.
--
-- Both are array columns defaulting to empty, and both are read with an
-- "empty means no constraint" rule, so existing rows keep their current
-- behaviour without a backfill: a member with no skills stays eligible for
-- skill-free routing, and a business muting nothing keeps every alert.
--
-- No index on `skills`. The only query that reads it
-- (`findAssignableTeamMembersWithSkills`) is already bounded by an explicit
-- `id IN (...)` list and the existing business_id/status index; the skill
-- match itself happens over that handful of rows in application code, so a
-- GIN index would be maintained on every write and never seeked.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Routing skills on team members
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "team_members"
    ADD COLUMN IF NOT EXISTS "skills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Muted channels on business notification settings
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "business_notification_settings"
    ADD COLUMN IF NOT EXISTS "muted_channels" TEXT[] DEFAULT ARRAY[]::TEXT[];
