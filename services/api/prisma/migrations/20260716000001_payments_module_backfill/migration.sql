-- Phase 6 follow-up: backfill the `payments` platform module for tenants that
-- existed BEFORE this release. `defaultEnabled: true` in the code catalog only
-- affects tenants created afterwards (DEFAULT_ENABLED_MODULE_CODES at tenant
-- creation); without this backfill, pre-existing tenants would have no
-- TenantModule row and ModuleEnabledGuard would 403 every /payments,
-- /payment-events, and /reconciliation call despite the catalog declaring the
-- module default-enabled. Mirrors the Phase 5 checkout backfill exactly.

-- 1. Ensure the PlatformModule row exists AND is active. Migrations run before
--    any seed on an upgraded deployment, so the backfill cannot rely on
--    `db:seed` having created it. A `payments` row from an earlier catalog may
--    already carry `isActive = false`; DO NOTHING would leave it inactive and
--    PlatformModulesService.isEnabledForTenant() would still 403 every payment
--    request despite the tenant enablement rows below. The upsert refreshes
--    name/description and forces `isActive = true` while PRESERVING the
--    existing row's id (no duplicate row, `code` stays unique). Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-payments-phase6',
  'payments',
  'Payments & Reconciliation',
  'Provider-neutral payment intents, simulated authorization/capture, provider event ingestion, and the reconciliation foundation (no live gateway; no raw card data).',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 2. Backfill the Phase 6 permission catalog rows. On an upgraded database,
--    `prisma migrate deploy` runs WITHOUT the separately guarded `db:seed`, so
--    without these inserts no tenant role could ever be granted the new
--    payment/reconciliation permission codes (effective permissions load only
--    through RolePermission → Permission rows) and every payment endpoint
--    would stay 403 despite the module being enabled. Idempotent upsert keyed
--    on the unique `code`, mirroring seedPermissions(); deterministic ids.
INSERT INTO "Permission" ("id", "code", "description", "module", "createdAt", "updatedAt")
VALUES
  ('perm-payment-read-p6', 'payment:read', 'View payment intents, authorizations, captures, and events', 'payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-payment-manage-p6', 'payment:manage', 'Create payment intents and manage their linkage (no live gateway)', 'payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-payment-simulate-p6', 'payment:simulate', 'Simulate provider-abstract authorization, capture, cancel/void, failure, and provider events', 'payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-reconciliation-read-p6', 'reconciliation:read', 'View payment reconciliation records', 'payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-reconciliation-manage-p6', 'reconciliation:manage', 'Update reconciliation record status (mark reconciled/mismatch — no settlement accounting)', 'payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "description" = EXCLUDED."description",
  "module" = EXCLUDED."module",
  "updatedAt" = CURRENT_TIMESTAMP;

-- 3. Enable the module for every existing tenant that does not already have an
--    enablement row. ON CONFLICT ("tenantId", "moduleId") DO NOTHING makes the
--    backfill idempotent and never overwrites a tenant's own choice (e.g. a
--    row a tenant admin already created or disabled). The id is deterministic
--    (md5 of tenantId + module code) so re-runs cannot even race on id
--    generation.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleId", "status", "enabledAt", "createdAt", "updatedAt")
SELECT
  'tm-' || md5(t."id" || ':payments'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'payments'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
