-- Phase 12 blocker patch — honest pilot metrics and a strict credential
-- slot format.
--
-- 1. Metric names stop conflating concepts (Codex P1): windows DETECTED
--    vs windows PROCESSED, and crop FRAMES (pre/peak/post evidence
--    frames) vs clip ARTIFACTS (none are generated in Phase 12, so that
--    counter stays 0 honestly instead of borrowing the crop count).
-- 2. credentialRef tightens from a generic identifier to the reserved
--    CAMERA_SECRET_SLOT_* namespace — a value in that shape cannot be a
--    password, PAN, key, token, URL, or connection string.

-- AlterTable (renames keep the existing non-negative CHECK valid — the
-- constraint tracks column attributes, not names)
ALTER TABLE "CameraPilotRun" RENAME COLUMN "candidateEvents" TO "eventWindowsDetected";
ALTER TABLE "CameraPilotRun" RENAME COLUMN "clipsGenerated" TO "cropFramesGenerated";
ALTER TABLE "CameraPilotRun" ADD COLUMN "eventWindowsProcessed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CameraPilotRun" ADD COLUMN "clipArtifactsGenerated" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "camera_run_window_counters_non_negative"
  CHECK ("eventWindowsProcessed" >= 0 AND "clipArtifactsGenerated" >= 0);

-- Strict allowlist slot format: server-recognizable, visibly non-secret.
ALTER TABLE "CameraSource" DROP CONSTRAINT "camera_source_credential_ref_identifier";
ALTER TABLE "CameraSource" ADD CONSTRAINT "camera_source_credential_ref_slot_format"
  CHECK ("credentialRef" IS NULL OR "credentialRef" ~ '^CAMERA_SECRET_SLOT_[A-Z0-9_]{3,40}$');
