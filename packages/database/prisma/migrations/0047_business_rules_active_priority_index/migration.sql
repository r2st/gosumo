-- CreateIndex
CREATE INDEX IF NOT EXISTS "business_rules_business_id_is_active_deleted_at_priority_idx"
ON "business_rules" ("business_id", "is_active", "deleted_at", "priority" DESC);
