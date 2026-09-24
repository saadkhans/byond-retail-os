-- Phase 25 follow-up: backfill the `pricing` platform module for tenants that
-- existed BEFORE this release, exactly as Phase 5 did for `checkout`.
-- `defaultEnabled: true` in the code catalog only applies at tenant creation,
-- so without this every pre-existing tenant would hit a 403 from
-- ModuleEnabledGuard on /price-books despite the catalog declaring the module
-- default-enabled — and checkout lines would silently stay unpriced.

-- 1. Ensure the PlatformModule row exists AND is active. Databases seeded
--    before this release already carry a `pricing` row from the old catalog
--    with `isActive = false`; DO NOTHING would leave it inactive and
--    PlatformModulesService.isEnabledForTenant() would keep returning false.
--    The upsert therefore forces `isActive = true` and refreshes the
--    name/description while PRESERVING the existing row's id. Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-pricing-phase25',
  'pricing',
  'Pricing',
  'Versioned, auditable, reversible price books: effective-dated versions, immutable entries, activation and rollback, and the resolved prices checkout snapshots onto basket lines.',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 2. Enable it for every existing tenant that has no enablement row yet.
--    DO NOTHING keeps the backfill idempotent and never overwrites a choice a
--    tenant admin already made. The id is deterministic (md5 of tenantId +
--    module code) so re-runs cannot race on id generation.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleId", "status", "enabledAt", "createdAt", "updatedAt")
SELECT
  'tm-' || md5(t."id" || ':pricing'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'pricing'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
