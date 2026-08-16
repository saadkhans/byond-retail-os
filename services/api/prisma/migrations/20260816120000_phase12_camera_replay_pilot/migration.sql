-- Phase 12 — edge camera replay runtime (SHADOW pilot).
--
-- CameraSource: where footage comes from (FILE_REPLAY functional; RTSP /
-- webcam registered placeholders). No URL and no secret is ever stored —
-- connectionNote is screened free text and credentialRef is the NAME of
-- an operator-managed secret slot, never its value.
-- CameraPilotRun: one auditable replay of a video asset through the
-- existing shadow pipeline, with per-stage counters/timings and the
-- journey's final shadow decision snapshot. Nothing here references
-- checkout, order, payment, or inventory tables.

-- CreateEnum
CREATE TYPE "CameraSourceType" AS ENUM ('FILE_REPLAY', 'RTSP_PLACEHOLDER', 'LOCAL_WEBCAM_PLACEHOLDER');

-- CreateEnum
CREATE TYPE "CameraSourceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "CameraPilotRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "CameraSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "unitId" TEXT,
    "name" TEXT NOT NULL,
    "shelfZone" TEXT,
    "sourceType" "CameraSourceType" NOT NULL,
    "status" "CameraSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectionNote" TEXT,
    "credentialRef" TEXT,
    "replayVideoAssetId" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraPilotRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraSourceId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "journeyId" TEXT,
    "status" "CameraPilotRunStatus" NOT NULL DEFAULT 'RUNNING',
    "frameIntervalMs" INTEGER NOT NULL,
    "framesProcessed" INTEGER NOT NULL DEFAULT 0,
    "candidateEvents" INTEGER NOT NULL DEFAULT 0,
    "clipsGenerated" INTEGER NOT NULL DEFAULT 0,
    "fusionRunsCompleted" INTEGER NOT NULL DEFAULT 0,
    "vlmInvoked" INTEGER NOT NULL DEFAULT 0,
    "vlmSkipped" INTEGER NOT NULL DEFAULT 0,
    "vlmFailed" INTEGER NOT NULL DEFAULT 0,
    "journeyEventsCreated" INTEGER NOT NULL DEFAULT 0,
    "reviewNeeded" INTEGER NOT NULL DEFAULT 0,
    "decision" "CustomerJourneyDecision",
    "eventWindows" JSONB,
    "stageTimings" JSONB,
    "errors" JSONB,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraPilotRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CameraSource_id_tenantId_key" ON "CameraSource"("id", "tenantId");
CREATE UNIQUE INDEX "CameraSource_tenantId_locationId_name_key" ON "CameraSource"("tenantId", "locationId", "name");
CREATE INDEX "CameraSource_tenantId_status_idx" ON "CameraSource"("tenantId", "status");
CREATE UNIQUE INDEX "CameraPilotRun_id_tenantId_key" ON "CameraPilotRun"("id", "tenantId");
CREATE UNIQUE INDEX "CameraPilotRun_tenantId_idempotencyKey_key" ON "CameraPilotRun"("tenantId", "idempotencyKey");
CREATE INDEX "CameraPilotRun_tenantId_createdAt_idx" ON "CameraPilotRun"("tenantId", "createdAt" DESC);
CREATE INDEX "CameraPilotRun_tenantId_cameraSourceId_createdAt_idx" ON "CameraPilotRun"("tenantId", "cameraSourceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CameraSource" ADD CONSTRAINT "CameraSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraSource" ADD CONSTRAINT "CameraSource_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraSource" ADD CONSTRAINT "CameraSource_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraSource" ADD CONSTRAINT "CameraSource_replayVideoAssetId_fkey" FOREIGN KEY ("replayVideoAssetId") REFERENCES "VideoAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_cameraSourceId_fkey" FOREIGN KEY ("cameraSourceId") REFERENCES "CameraSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "CustomerJourney"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same-tenant composite FKs (AGENTS.md: tenancy — repository scoping alone
-- is not enough). Actions mirror each sibling single-column FK above.
-- CameraSource.replayVideoAssetId is the ONE exception with no composite
-- pair: its single-column FK is ON DELETE SET NULL (a deleted test asset
-- must detach, not block), and a composite RESTRICT beside it would veto
-- that very SET NULL. The same-tenant guarantee for this pointer is
-- enforced at the service layer (asset resolved tenant-scoped before
-- every write) — same stance as the createdById exception in
-- 20260811110000_cv_same_tenant_fks.
ALTER TABLE "CameraSource" ADD CONSTRAINT "CameraSource_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraSource" ADD CONSTRAINT "CameraSource_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_source_same_tenant_fkey" FOREIGN KEY ("cameraSourceId", "tenantId") REFERENCES "CameraSource"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_videoAsset_same_tenant_fkey" FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "CameraPilotRun_journey_same_tenant_fkey" FOREIGN KEY ("journeyId", "tenantId") REFERENCES "CustomerJourney"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints — counters can never go negative, the replay frame
-- interval stays inside a sane band (>= 40ms ≈ 25fps ceiling, <= 60s),
-- and credentialRef is a bare identifier (a secret-slot NAME), never a
-- URL or secret-bearing string.
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "camera_run_counters_non_negative"
  CHECK ("framesProcessed" >= 0 AND "candidateEvents" >= 0 AND "clipsGenerated" >= 0
     AND "fusionRunsCompleted" >= 0 AND "vlmInvoked" >= 0 AND "vlmSkipped" >= 0
     AND "vlmFailed" >= 0 AND "journeyEventsCreated" >= 0 AND "reviewNeeded" >= 0);
ALTER TABLE "CameraPilotRun" ADD CONSTRAINT "camera_run_frame_interval_band"
  CHECK ("frameIntervalMs" >= 40 AND "frameIntervalMs" <= 60000);
ALTER TABLE "CameraSource" ADD CONSTRAINT "camera_source_credential_ref_identifier"
  CHECK ("credentialRef" IS NULL OR "credentialRef" ~ '^[A-Za-z0-9_.-]{1,64}$');
