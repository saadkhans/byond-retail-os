-- Phase 10 follow-up (Codex P1: screen frame content before persisting
-- uploads): quarantine-until-screened pipeline.
--
-- The upload attestation (`attestNoSensitiveContent=true`) proves nothing
-- about the BYTES — an operator can mistakenly or maliciously attest a clip
-- that shows a payment card. Uploads therefore no longer land processable:
-- every new asset is created QUARANTINED, and while QUARANTINED it cannot be
-- validated, sampled, or cropped (controlled 409 at every processing entry
-- point; bytes are never served module-wide). A new audited screening
-- decision (`POST /video-assets/:id/screening`, permission
-- `video-asset:screen`) either APPROVEs (QUARANTINED → UPLOADED) or REJECTs
-- (stored media removed, QUARANTINED → REJECTED, metadata kept as evidence).
-- Quarantine is a LIFECYCLE STATE enforced at every processing entry point,
-- not a separate storage directory — files never move, so no new orphan
-- classes exist. Automated CV frame screening (a later phase) plugs into the
-- same screening step.

-- 1. New lifecycle value. Postgres 12+ allows ADD VALUE inside a transaction
--    as long as the NEW value is not used in the same transaction — nothing
--    below references it. The DB column default stays 'UPLOADED'; the
--    repository sets QUARANTINED explicitly on every create, so no ALTER
--    COLUMN (which would use the new value) is needed here.
ALTER TYPE "VideoAssetStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED' BEFORE 'UPLOADED';

-- 2. Backfill the screening permission. `prisma migrate deploy` runs WITHOUT
--    the separately guarded `db:seed`, so without this insert no tenant role
--    could ever be granted the new code and the screening endpoint would stay
--    403 on upgraded databases. Idempotent upsert keyed on the unique
--    `code`, mirroring the Phase 10 backfill migration; deterministic id.
INSERT INTO "Permission" ("id", "code", "description", "module", "createdAt", "updatedAt")
VALUES
  ('perm-video-asset-screen-p10', 'video-asset:screen', 'Record the audited frame-content screening decision that releases (QUARANTINED to UPLOADED) or rejects (media removed) a quarantined upload', 'video-ingest', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "description" = EXCLUDED."description",
  "module" = EXCLUDED."module",
  "updatedAt" = CURRENT_TIMESTAMP;
