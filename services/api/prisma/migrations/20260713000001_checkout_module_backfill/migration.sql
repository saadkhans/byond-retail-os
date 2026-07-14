-- Phase 5 follow-up: backfill the `checkout` platform module for tenants that
-- existed BEFORE this release. `defaultEnabled: true` in the code catalog
-- only affects tenants created afterwards (DEFAULT_ENABLED_MODULE_CODES at
-- tenant creation); without this backfill, pre-existing tenants would have
-- no TenantModule row and ModuleEnabledGuard would 403 every
-- /checkout-sessions and /orders call despite the catalog declaring the
-- module default-enabled.

-- 1. Ensure the PlatformModule row exists. Migrations run before any seed on
--    an upgraded deployment, so the backfill cannot rely on `db:seed` having
--    created it. Idempotent: the seed later upserts (keyed on the unique
--    `code`) and keeps name/description/isActive in sync with the catalog.
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
ON CONFLICT ("code") DO NOTHING;

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
