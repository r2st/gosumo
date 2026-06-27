-- Migration: 0020_add_onboarding_progress
-- Adds the guided-onboarding wizard state column to businesses.
--
-- Stores per-step status (pending/completed/skipped), collected step data,
-- the current step, and a completion timestamp. Owned by the onboarding
-- module (apps/api/src/modules/onboarding). Defaults to an empty object so
-- existing rows are treated as "not started".

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "onboarding_progress" JSONB NOT NULL DEFAULT '{}'::jsonb;
