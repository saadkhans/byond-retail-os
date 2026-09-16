-- Phase 31 follow-up: backfill the `procurement` platform module for tenants
-- that existed BEFORE this release, exactly as Phase 25 did for `pricing`.
-- `defaultEnabled: true` in the code catalog only applies at tenant creation,
-- so without this every pre-existing tenant would hit a 403 from
-- ModuleEnabledGuard on /suppliers and /purchase-orders despite the catalog
-- declaring the module default-enabled.

-- 1. Ensure the PlatformModule row exists AND is active. Databases seeded
--    before this release already carry a `procurement` row from the old
--    catalog with `isActive = false`; DO NOTHING would leave it inactive and
--    PlatformModulesService.isEnabledForTenant() would keep returning false.
--    The upsert therefore forces `isActive = true` and refreshes the
--    name/description while PRESERVING the existing row's id. Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-procurement-phase31',
  'procurement',
  'Procurement',
  'Suppliers, supplier catalog and costs, purchase orders, and goods receipts that admit stock through the append-only inventory ledger.',
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
  'tm-' || md5(t."id" || ':procurement'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'procurement'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
