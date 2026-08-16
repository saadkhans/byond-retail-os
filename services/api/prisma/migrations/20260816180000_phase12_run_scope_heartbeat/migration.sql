-- Phase 12 blocker patch, round 2.
--
-- 1. PickupFusionRun.runScope separates WHOLE_CLIP runs (the unit of
--    ground-truthed evaluation) from REPLAY_WINDOW runs (one extracted
--    event window of a camera replay). Window runs are excluded from
--    whole-clip metrics so a pilot replay can never displace the
--    evaluation result of its underlying test video. Existing rows whose
--    evidence carries a replayWindow marker are backfilled as
--    REPLAY_WINDOW; everything else predates windows and is WHOLE_CLIP.
-- 2. CameraPilotRun.heartbeatAt gives stale-run recovery lease
--    semantics: a RUNNING replay is reclaimable only when its heartbeat
--    has expired, never merely because it started long ago.

-- CreateEnum
CREATE TYPE "FusionRunScope" AS ENUM ('WHOLE_CLIP', 'REPLAY_WINDOW');

-- AlterTable
ALTER TABLE "PickupFusionRun" ADD COLUMN "runScope" "FusionRunScope" NOT NULL DEFAULT 'WHOLE_CLIP';

-- Backfill: runs produced by the replay runtime stamped their window into
-- the evidence JSON (evidence.replayWindow) before this column existed.
UPDATE "PickupFusionRun" SET "runScope" = 'REPLAY_WINDOW' WHERE "evidence" ? 'replayWindow';

-- AlterTable
ALTER TABLE "CameraPilotRun" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

-- CreateIndex (evaluation reads filter on scope per asset)
CREATE INDEX "PickupFusionRun_tenantId_runScope_videoAssetId_createdAt_idx" ON "PickupFusionRun"("tenantId", "runScope", "videoAssetId", "createdAt" DESC);
