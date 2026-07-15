-- Phase 5 follow-up: backfill the `checkout` platform module for tenants that
-- existed BEFORE this release. `defaultEnabled: true` in the code catalog
-- only affects tenants created afterwards (DEFAULT_ENABLED_MODULE_CODES at
-- tenant creation); without this backfill, pre-existing tenants would have
-- no TenantModule row and ModuleEnabledGuard would 403 every
-- /checkout-sessions and /orders call despite the catalog declaring the
-- module default-enabled.

-- 1. Ensure the PlatformModule row exists AND is active. Migrations run
--    before any seed on an upgraded deployment, so the backfill cannot rely
--    on `db:seed` having created it. Databases seeded BEFORE Phase 5 may
--    already carry a `checkout` row from an earlier catalog with
--    `isActive = false`; DO NOTHING would leave it inactive and
--    PlatformModulesService.isEnabledForTenant() would still 403 every
--    checkout/orders request despite the tenant enablement rows below. The
--    upsert therefore refreshes name/description and forces `isActive = true`
--    while PRESERVING the existing row's id (no duplicate row, `code` stays
--    unique). Idempotent: re-running converges on the same catalog values.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-checkout-phase5',
  'checkout',
  'Checkout & Orders',
  'Checkout sessions, basket lines, and the order foundation (no payment capture; payments arrive in a later phase).',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 2. Enable the module for every existing tenant that does not already have
--    an enablement row. ON CONFLICT ("tenantId", "moduleId") DO NOTHING makes
--    the backfill idempotent and never overwrites a tenant's own choice
--    (e.g. a row a tenant admin already created or disabled). The id is
--    deterministic (md5 of tenantId + module code) so re-runs cannot even
--    race on id generation.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleId", "status", "enabledAt", "createdAt", "updatedAt")
SELECT
  'tm-' || md5(t."id" || ':checkout'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'checkout'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
