-- Add GITHUB and MICROSOFT to AuthProvider enum
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'GITHUB';
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'MICROSOFT';

-- Add github_id and microsoft_id columns to team_members
ALTER TABLE "team_members" ADD COLUMN "github_id" VARCHAR(255);
ALTER TABLE "team_members" ADD COLUMN "microsoft_id" VARCHAR(255);

-- Unique indexes for OAuth lookups
CREATE UNIQUE INDEX "team_members_github_id_key" ON "team_members"("github_id");
CREATE UNIQUE INDEX "team_members_microsoft_id_key" ON "team_members"("microsoft_id");
