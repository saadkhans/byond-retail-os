-- Phase 18 (Codex P1 hardening) — calibration content fingerprint.
-- sha256 over SAFE calibration metadata (profile id/version/orientation/
-- mount/updatedAt, zone counts by type, sorted zone ids, max zone
-- updatedAt), captured at candidate refresh when the linked calibration
-- profile is stamped on eligible candidates. Export recomputes the
-- fingerprint and rejects on any difference, so profile edits and zone
-- additions/updates/DELETIONS after the refresh can never silently
-- change an export manifest. Contains no zone labels, polygons, product
-- details, URLs, paths, or credential material.

-- AlterTable
ALTER TABLE "CvDatasetImprovementRun" ADD COLUMN "calibrationFingerprint" TEXT;
