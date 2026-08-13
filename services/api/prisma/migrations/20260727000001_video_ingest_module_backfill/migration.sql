-- Phase 10 follow-up: backfill the `video-ingest` platform module for tenants
-- that existed BEFORE this release. `defaultEnabled: true` in the code
-- catalog only affects tenants created afterwards (DEFAULT_ENABLED_MODULE_CODES
-- at tenant creation); without this backfill, pre-existing tenants would have
-- no TenantModule row and ModuleEnabledGuard would 403 every /video-assets
-- call despite the catalog declaring the module default-enabled. Mirrors the
-- Phase 9 inference backfill exactly (module upsert + permission upsert +
-- tenant enablement).

-- 1. Ensure the PlatformModule row exists AND is active. Migrations run
--    before any seed on an upgraded deployment, so the backfill cannot rely
--    on `db:seed` having created it. A `video-ingest` row from an earlier
--    catalog may already carry `isActive = false`; DO NOTHING would leave it
--    inactive and PlatformModulesService.isEnabledForTenant() would still 403
--    every video-assets request despite the tenant enablement rows below. The
--    upsert refreshes name/description and forces `isActive = true` while
--    PRESERVING the existing row's id (no duplicate row, `code` stays
--    unique). Idempotent.
INSERT INTO "PlatformModule" ("id", "code", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  'pm-video-ingest-phase10',
  'video-ingest',
  'Video Ingestion',
  'Controlled test video upload, safe local/dev media storage, frame/crop extraction contracts, and the connection from crop artifacts to Phase 9 inference jobs (no production camera runtime; no real model execution; no raw media in the database).',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 2. Backfill the Phase 10 permission catalog rows. On an upgraded database,
--    `prisma migrate deploy` runs WITHOUT the separately guarded `db:seed`,
--    so without these inserts no tenant role could ever be granted the new
--    video-asset permission codes (effective permissions load only through
--    RolePermission → Permission rows) and every video-assets endpoint would
--    stay 403 despite the module being enabled. Idempotent upsert keyed on
--    the unique `code`, mirroring seedPermissions(); deterministic ids.
INSERT INTO "Permission" ("id", "code", "description", "module", "createdAt", "updatedAt")
VALUES
  ('perm-video-asset-read-p10', 'video-asset:read', 'View video assets and their frame/crop artifacts', 'video-ingest', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-video-asset-manage-p10', 'video-asset:manage', 'Upload controlled test videos and manage their metadata', 'video-ingest', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-video-asset-process-p10', 'video-asset:process', 'Validate videos, extract frames/crops, and create inference jobs from crops', 'video-ingest', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('perm-video-asset-delete-p10', 'video-asset:delete', 'Delete video assets (removes the local file, keeps audited metadata)', 'video-ingest', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
  'tm-' || md5(t."id" || ':video-ingest'),
  t."id",
  pm."id",
  'ENABLED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "PlatformModule" pm
WHERE pm."code" = 'video-ingest'
ON CONFLICT ("tenantId", "moduleId") DO NOTHING;
