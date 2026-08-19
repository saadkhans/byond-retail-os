-- Phase 13 — live RTSP shadow sessions.
--
-- 1. CameraSourceType gains RTSP_SHADOW: the first LIVE source type,
--    still shadow-only. The stream URL lives ONLY in operator-managed
--    runtime configuration (CAMERA_RTSP_SOURCE_<SLOT>), never in this
--    database. The *_PLACEHOLDER types keep their can-never-activate
--    rule.
-- 2. FusionRunScope gains LIVE_WINDOW: one live-sampled event window of
--    an RTSP session. Excluded from whole-clip evaluation like
--    REPLAY_WINDOW (those surfaces filter WHOLE_CLIP explicitly).
-- 3. PickupFusionRun.videoAssetId becomes nullable + liveSessionId is
--    added: a LIVE_WINDOW run analyzes sampled frames — there is no
--    video asset. Exactly one origin is set (CHECK below, expressed over
--    ::text so the enum value added in this transaction is never used as
--    an enum literal here).
-- 4. LiveCameraSession: one auditable row per live camera start, with
--    lease/heartbeat columns and CONTROLLED error codes only. At most
--    one non-terminal session per camera source (partial unique index).

-- AlterEnum
ALTER TYPE "CameraSourceType" ADD VALUE 'RTSP_SHADOW';

-- AlterEnum
ALTER TYPE "FusionRunScope" ADD VALUE 'LIVE_WINDOW';

-- CreateEnum
CREATE TYPE "LiveCameraSessionStatus" AS ENUM ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');

-- AlterTable
ALTER TABLE "PickupFusionRun" ALTER COLUMN "videoAssetId" DROP NOT NULL;
ALTER TABLE "PickupFusionRun" ADD COLUMN "liveSessionId" TEXT;

-- CreateTable
CREATE TABLE "LiveCameraSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraSourceId" TEXT NOT NULL,
    "journeyId" TEXT,
    "status" "LiveCameraSessionStatus" NOT NULL DEFAULT 'STARTING',
    "frameIntervalMs" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastFrameAt" TIMESTAMP(3),
    "framesSampled" INTEGER NOT NULL DEFAULT 0,
    "eventWindowsDetected" INTEGER NOT NULL DEFAULT 0,
    "eventWindowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "fusionRunsCompleted" INTEGER NOT NULL DEFAULT 0,
    "journeyEventsCreated" INTEGER NOT NULL DEFAULT 0,
    "vlmInvoked" INTEGER NOT NULL DEFAULT 0,
    "vlmSkipped" INTEGER NOT NULL DEFAULT 0,
    "vlmFailed" INTEGER NOT NULL DEFAULT 0,
    "reviewNeeded" INTEGER NOT NULL DEFAULT 0,
    "decision" "CustomerJourneyDecision",
    "errorCode" TEXT,
    "eventWindows" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveCameraSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveCameraSession_id_tenantId_key" ON "LiveCameraSession"("id", "tenantId");
CREATE INDEX "LiveCameraSession_tenantId_cameraSourceId_createdAt_idx" ON "LiveCameraSession"("tenantId", "cameraSourceId", "createdAt" DESC);
CREATE INDEX "LiveCameraSession_tenantId_status_idx" ON "LiveCameraSession"("tenantId", "status");
CREATE INDEX "PickupFusionRun_tenantId_liveSessionId_createdAt_idx" ON "PickupFusionRun"("tenantId", "liveSessionId", "createdAt" DESC);

-- At most ONE non-terminal session per camera source: the database is
-- the race backstop for concurrent starts, exactly like the idempotency
-- unique on CameraPilotRun. (LiveCameraSessionStatus is CREATED in this
-- migration, so its values are usable here.)
CREATE UNIQUE INDEX "LiveCameraSession_one_active_per_source"
  ON "LiveCameraSession"("tenantId", "cameraSourceId")
  WHERE "status" IN ('STARTING', 'RUNNING', 'STOPPING');

-- AddForeignKey
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "LiveCameraSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "LiveCameraSession_cameraSourceId_fkey" FOREIGN KEY ("cameraSourceId") REFERENCES "CameraSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "LiveCameraSession_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "CustomerJourney"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "PickupFusionRun_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveCameraSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same-tenant composite FKs (AGENTS.md: tenancy). Actions mirror each
-- sibling single-column FK above.
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "LiveCameraSession_source_same_tenant_fkey" FOREIGN KEY ("cameraSourceId", "tenantId") REFERENCES "CameraSource"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "LiveCameraSession_journey_same_tenant_fkey" FOREIGN KEY ("journeyId", "tenantId") REFERENCES "CustomerJourney"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "PickupFusionRun_liveSession_same_tenant_fkey" FOREIGN KEY ("liveSessionId", "tenantId") REFERENCES "LiveCameraSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints. runScope/videoAssetId/liveSessionId coherence is
-- compared over ::text so the LIVE_WINDOW value added in this same
-- transaction is never referenced as an enum literal:
--   * every run has exactly ONE origin (asset XOR live session);
--   * only LIVE_WINDOW runs may carry a live session origin.
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "fusion_run_exactly_one_origin"
  CHECK (("videoAssetId" IS NOT NULL AND "liveSessionId" IS NULL)
      OR ("videoAssetId" IS NULL AND "liveSessionId" IS NOT NULL));
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "fusion_run_live_origin_scope"
  CHECK ("liveSessionId" IS NULL OR "runScope"::text = 'LIVE_WINDOW');
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "live_session_counters_non_negative"
  CHECK ("framesSampled" >= 0 AND "eventWindowsDetected" >= 0
     AND "eventWindowsProcessed" >= 0 AND "fusionRunsCompleted" >= 0
     AND "journeyEventsCreated" >= 0 AND "vlmInvoked" >= 0
     AND "vlmSkipped" >= 0 AND "vlmFailed" >= 0 AND "reviewNeeded" >= 0);
ALTER TABLE "LiveCameraSession" ADD CONSTRAINT "live_session_frame_interval_band"
  CHECK ("frameIntervalMs" >= 500 AND "frameIntervalMs" <= 60000);
