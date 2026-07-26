-- Phase 9 follow-up: backfill the `inference` platform module for tenants
-- that existed BEFORE this release. `defaultEnabled: true` in the code
-- catalog only affects tenants created afterwards (DEFAULT_ENABLED_MODULE_CODES
-- at tenant creation); without this backfill, pre-existing tenants would have
-- no TenantModule row and ModuleEnabledGuard would 403 every /inference/jobs
-- call despite the catalog declaring the module default-enabled. Mirrors the
-- Phase 6 payments backfill exactly (module upsert + permission upsert +
-- tenant enablement).

-- 1. Ensure the PlatformModule row exists AND is active. Migrations run
--    before any seed on an upgraded deployment, so the backfill cannot rely
--    on `db:seed` having created it. An `inference` row from an earlier
--    catalog may already carry `isActive = false`; DO NOTHING would leave it
--    inactive and PlatformModulesService.isEnabledForTenant() would still 403
--    every inference request despite the tenant enablement rows below. The
--    upsert refreshes name/description and forces `isActive = true` while
--    PRESERVING the existing row's id (no duplicate row, `code` stays
--    unique). Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-inference-phase9',
  'inference',
  'CV Inference',
  'Provider-neutral CV inference jobs, the database-backed queue foundation, the simulated adapter, and the conversion of successful results into Phase 7 vision events (no runtime ML or video dependency; no real model execution).',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 2. Backfill the Phase 9 permission catalog rows. On an upgraded database,
--    `prisma migrate deploy` runs WITHOUT the separately guarded `db:seed`,
--    so without these inserts no tenant role could ever be granted the new
--    inference permission codes (effective permissions load only through
--    RolePermission → Permission rows) and every inference endpoint would
--    stay 403 despite the module being enabled. Idempotent upsert keyed on
--    the unique `code`, mirroring seedPermissions(); deterministic ids.
INSERT INTO "Permission" ("id", "code", "description", "module", "createdAt", "updatedAt")
VALUES
  ('perm-inference-read-p9', 'inference:read', 'View inference jobs, results, and SKU candidate rankings', 'inference', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-inference-manage-p9', 'inference:manage', 'Create inference jobs and drive their lifecycle (start, fail)', 'inference', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-inference-simulate-p9', 'inference:simulate', 'Complete jobs with simulated adapter output (no real model execution)', 'inference', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-inference-apply-p9', 'inference:apply', 'Convert a successful inference result into a Phase 7 vision event', 'inference', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "description" = EXCLUDED."description",
  "module" = EXCLUDED."module",
  "updatedAt" = CURRENT_TIMESTAMP;

-- 3. Enable the module for every existing tenant that does not already have
--    an enablement row. ON CONFLICT ("tenantId", "moduleId") DO NOTHING makes
--    the backfill idempotent and never overwrites a tenant's own choice
--    (e.g. a row a tenant admin already created or disabled). The id is
--    deterministic (md5 of tenantId + module code) so re-runs cannot even
--    race on id generation.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleId", "status", "enabledAt", "createdAt", "updatedAt")
SELECT
  'tm-' || md5(t."id" || ':inference'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'inference'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
