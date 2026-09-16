-- Phase 26 follow-up: register the `store-flow` platform module and enable it
-- for tenants that existed BEFORE this release, exactly as Phase 5 did for
-- `checkout` and Phase 25 for `pricing`. `defaultEnabled: true` in the code
-- catalog only applies at tenant creation, so without this every pre-existing
-- tenant would hit a 403 from ModuleEnabledGuard on /store-flow routes.
--
-- Enabling the module does NOT switch a store to autonomous operation: the
-- autonomy policy defaults to SHADOW, which reproduces the behaviour of every
-- phase before this one. An operator has to opt in per tenant or per store.

-- 1. Ensure the PlatformModule row exists and is active. Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-store-flow-phase26',
  'store-flow',
  'Store Flow',
  'Shopper entry and identity, the governed bridge from observed pickups to basket lines, one review queue over both streams, and exit settlement into an order and a payment.',
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
  'tm-' || md5(t."id" || ':store-flow'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'store-flow'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
