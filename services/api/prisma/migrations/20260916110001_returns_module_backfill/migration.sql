-- Phase 27 follow-up: register the `returns` platform module and enable it for
-- tenants that existed BEFORE this release, exactly as Phase 25 did for
-- `pricing` and Phase 26 for `store-flow`. `defaultEnabled: true` in the code
-- catalog only applies at tenant creation, so without this every pre-existing
-- tenant would hit a 403 from ModuleEnabledGuard on /returns, /cycle-counts
-- and /shrink-events.
--
-- Enabling the module changes NOTHING on its own: there are no background
-- jobs here. A return, a cancellation, a count and a shrink each happen only
-- when an operator with the matching permission asks for one.

-- 1. Ensure the PlatformModule row exists and is active. Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-returns-phase27',
  'returns',
  'Returns & Reconciliation',
  'Refunds against captured payments, stock reversal on returned and cancelled orders, cycle counts and stocktakes that reconcile the stock projection against the ledger, and the shrink path for CV-detected loss.',
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
  'tm-' || md5(t."id" || ':returns'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'returns'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
