-- Phase 13 stabilization (Codex P1): a parked finalization must resume
-- with the SAME journey-closure semantics it started with. Deriving the
-- mode from the advisory errorCode let a marker-append failure (parked
-- under the marker's reason) convert an ERROR finalization into a clean
-- STOP on retry. The mode is now its own column, written when a
-- finalization parks and cleared on terminal writes.

-- AlterTable
ALTER TABLE "LiveCameraSession" ADD COLUMN "finalizationMode" TEXT;

-- Controlled vocabulary.
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "live_session_finalization_mode_vocabulary"
  CHECK ("finalizationMode" IS NULL OR "finalizationMode" IN ('STOP', 'ERROR'));
