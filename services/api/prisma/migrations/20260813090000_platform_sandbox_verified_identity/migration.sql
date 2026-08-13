-- Verified platform-sandbox identity (Codex round 7 P1): the reserved slug
-- alone is not proof a tenant row is the dedicated sandbox — a customer
-- tenant created before the slug was reserved could carry it. Platform
-- users must resolve only a tenant carrying this explicit marker, which is
-- set exclusively by the sandbox seeder.
ALTER TABLE "Tenant" ADD COLUMN "isPlatformSandbox" BOOLEAN NOT NULL DEFAULT false;

-- One-time adoption of a PRE-MARKER seeded sandbox: only a row carrying
-- BOTH the reserved slug AND the exact seeder-written display name is
-- adopted (the seeder is the only writer of that name). Any other row with
-- the slug stays unmarked — the seeder then refuses to take it over and
-- platform users fail closed instead of resolving it.
UPDATE "Tenant"
SET "isPlatformSandbox" = true
WHERE "slug" = 'platform-sandbox'
  AND "name" = 'Platform Sandbox (staff-staged test data only)';
