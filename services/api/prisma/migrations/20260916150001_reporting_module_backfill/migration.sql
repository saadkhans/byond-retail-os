-- Phase 30: make the `reporting` platform module REAL for tenants that
-- existed BEFORE this release, exactly as Phase 25/27/29/31 did for their
-- modules. `defaultEnabled: true` in the code catalog only applies at tenant
-- creation, so without this every pre-existing tenant would hit a 403 from
-- ModuleEnabledGuard on /reports despite the catalog declaring the module
-- default-enabled.
--
-- Phase 30 adds NO tables. Reporting derives every number on read from the
-- append-only inventory ledger, the order lines with their price/promotion
-- provenance, the cycle-count records and the evaluation tables. There is
-- deliberately nothing here to materialise: a stored figure could drift away
-- from the ledger it claims to summarise, and this phase refuses to create a
-- second source of truth.

-- 1. Ensure the PlatformModule row exists AND is active. Every database
--    seeded before this release already carries a `reporting` row from the
--    old catalog with `isActive = false` ("Analytics and reporting (later
--    phase)"); a DO NOTHING would leave it inactive and
--    PlatformModulesService.isEnabledForTenant() would keep returning false,
--    stranding every pre-existing tenant behind a 403. The upsert therefore
--    FORCES `isActive = true` and refreshes the name/description while
--    PRESERVING the existing row's id (TenantModule rows point at it).
--    Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-reporting-phase30',
  'reporting',
  'Reporting & Analytics',
  'Read-only sales, inventory, shrink and CV-accuracy reporting derived on read from the append-only ledger, the order lines with their price/promotion provenance, and the evaluation tables.',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 2. Seed the one permission this phase adds, so an existing database can
--    grant it without waiting for the next seed run. Enabling the module is
--    not enough on its own: every /reports route ALSO demands the permission
--    that already guards the rows it sums (order:read, inventory:read,
--    cycle-count:read, shrink:read, vision:read), so this grant can never
--    widen what a role can see.
INSERT INTO "Permission" ("id", "code", "module", "description", "createdAt", "updatedAt")
VALUES (
  'perm-report-read-phase30',
  'report:read',
  'reporting',
  'Open the reporting surface. Held ALONGSIDE the permission that already guards each report''s rows (order:read, inventory:read, cycle-count:read, shrink:read, vision:read) — reporting never widens what a user can see.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "description" = EXCLUDED."description",
  "updatedAt" = CURRENT_TIMESTAMP;

-- 3. Enable the module for every existing tenant that has no enablement row
--    yet. DO NOTHING keeps the backfill idempotent and never overwrites a
--    choice a tenant admin already made. The id is deterministic (md5 of
--    tenantId + module code) so re-runs cannot race on id generation.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleId", "status", "enabledAt", "createdAt", "updatedAt")
SELECT
  'tm-' || md5(t."id" || ':reporting'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'reporting'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
