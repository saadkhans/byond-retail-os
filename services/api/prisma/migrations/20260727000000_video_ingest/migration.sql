-- Phase 10: video ingestion & crop extraction foundation.
--
-- Controlled TEST videos only: rows carry metadata plus an INTERNAL storage
-- key (opaque, server-generated, relative to the local/dev storage root) —
-- raw media bytes never enter the database, no public or signed URLs exist,
-- and storage keys are never exposed through the API. Provider-neutral by
-- construction: no camera/streaming/model vendor columns; extraction runs
-- behind a port (simulated extractor by default, optional local system
-- binary adapter) with no runtime ML/video npm dependency.

-- CreateEnum
CREATE TYPE "VideoAssetStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'REJECTED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "VideoArtifactType" AS ENUM ('FRAME', 'CROP');

-- CreateEnum
CREATE TYPE "VideoCropReason" AS ENUM ('PRODUCT_PICKUP', 'PRODUCT_RETURN', 'SHELF_AUDIT', 'CART_INSERTION', 'OCR_REVIEW', 'VLM_REVIEW');

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "unitId" TEXT,
    "deviceId" TEXT,
    "sessionId" TEXT,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "status" "VideoAssetStatus" NOT NULL DEFAULT 'UPLOADED',
    "storageKey" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "uploadedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoArtifact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "artifactType" "VideoArtifactType" NOT NULL,
    "reason" "VideoCropReason",
    "timestampMs" INTEGER NOT NULL,
    "cropX" INTEGER,
    "cropY" INTEGER,
    "cropWidth" INTEGER,
    "cropHeight" INTEGER,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "inferenceJobId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoAsset_id_tenantId_key" ON "VideoAsset"("id", "tenantId");

-- CreateIndex
-- The DEFAULT (unfiltered) asset list orders by createdAt DESC, id DESC.
CREATE INDEX "VideoAsset_tenantId_createdAt_id_idx" ON "VideoAsset"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "VideoAsset_tenantId_status_idx" ON "VideoAsset"("tenantId", "status");

-- CreateIndex
CREATE INDEX "VideoAsset_tenantId_sessionId_idx" ON "VideoAsset"("tenantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoArtifact_id_tenantId_key" ON "VideoArtifact"("id", "tenantId");

-- CreateIndex
CREATE INDEX "VideoArtifact_tenantId_videoAssetId_createdAt_idx" ON "VideoArtifact"("tenantId", "videoAssetId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoArtifact_tenantId_createdAt_id_idx" ON "VideoArtifact"("tenantId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_inferenceJobId_fkey" FOREIGN KEY ("inferenceJobId") REFERENCES "InferenceJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- 1. Value sanity: sizes are positive, probed metadata is positive when
--    present, crop boxes are non-negative with positive dimensions, and a
--    CROP always carries a complete crop box while a FRAME never does. Error
--    codes exist exactly on REJECTED/FAILED assets. The application validates
--    first; these backstop any future code path that forgets to.
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_sizeBytes_positive_check"
  CHECK ("sizeBytes" > 0);
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_durationMs_positive_check"
  CHECK ("durationMs" IS NULL OR "durationMs" > 0);
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_dimensions_positive_check"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_fps_positive_check"
  CHECK ("fps" IS NULL OR "fps" > 0);
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_error_only_terminal_check"
  CHECK (("errorCode" IS NOT NULL) = ("status" IN ('REJECTED', 'FAILED')));
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_sizeBytes_positive_check"
  CHECK ("sizeBytes" > 0);
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_timestampMs_nonnegative_check"
  CHECK ("timestampMs" >= 0);
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_dimensions_positive_check"
  CHECK ("width" > 0 AND "height" > 0);
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_crop_box_check"
  CHECK (
    ("artifactType" = 'CROP' AND "cropX" IS NOT NULL AND "cropY" IS NOT NULL
      AND "cropWidth" IS NOT NULL AND "cropHeight" IS NOT NULL
      AND "cropX" >= 0 AND "cropY" >= 0 AND "cropWidth" > 0 AND "cropHeight" > 0)
    OR
    ("artifactType" = 'FRAME' AND "cropX" IS NULL AND "cropY" IS NULL
      AND "cropWidth" IS NULL AND "cropHeight" IS NULL)
  );

-- 2. Cross-tenant reference integrity at the database level (same pattern as
--    Phases 3-9): an asset can never reference another tenant's store/unit/
--    device/session/uploader; an artifact can never reference another
--    tenant's asset, inference job, or creator — even if an unscoped id ever
--    slipped through application code. (MATCH SIMPLE skips the check when the
--    nullable column is NULL — exactly what we want for optional references.)
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_device_same_tenant_fkey"
  FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_session_same_tenant_fkey"
  FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_uploader_same_tenant_fkey"
  FOREIGN KEY ("uploadedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_asset_same_tenant_fkey"
  FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_job_same_tenant_fkey"
  FOREIGN KEY ("inferenceJobId", "tenantId") REFERENCES "InferenceJob"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_creator_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Extraction output is tamper-evident: VideoArtifact rows are append-only
--    (same hardening as InferenceResult / the Phase 7 evidence tables) with
--    ONE exception — the one-shot inferenceJobId link may be set on a row
--    that does not carry one yet. Everything else about an extracted
--    frame/crop (position, box, checksum, storage key) never changes.
CREATE FUNCTION prevent_video_artifact_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."inferenceJobId" IS NULL
    AND NEW."inferenceJobId" IS NOT NULL
    AND NEW."id" = OLD."id"
    AND NEW."tenantId" = OLD."tenantId"
    AND NEW."videoAssetId" = OLD."videoAssetId"
    AND NEW."artifactType" = OLD."artifactType"
    AND NEW."reason" IS NOT DISTINCT FROM OLD."reason"
    AND NEW."timestampMs" = OLD."timestampMs"
    AND NEW."cropX" IS NOT DISTINCT FROM OLD."cropX"
    AND NEW."cropY" IS NOT DISTINCT FROM OLD."cropY"
    AND NEW."cropWidth" IS NOT DISTINCT FROM OLD."cropWidth"
    AND NEW."cropHeight" IS NOT DISTINCT FROM OLD."cropHeight"
    AND NEW."width" = OLD."width"
    AND NEW."height" = OLD."height"
    AND NEW."mimeType" = OLD."mimeType"
    AND NEW."sizeBytes" = OLD."sizeBytes"
    AND NEW."checksumSha256" = OLD."checksumSha256"
    AND NEW."storageKey" = OLD."storageKey"
    AND NEW."createdById" IS NOT DISTINCT FROM OLD."createdById"
    AND NEW."createdAt" = OLD."createdAt"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'VideoArtifact is append-only (one-shot inferenceJobId link excepted): % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER video_artifact_append_only
  BEFORE UPDATE OR DELETE ON "VideoArtifact"
  FOR EACH ROW EXECUTE FUNCTION prevent_video_artifact_mutation();

CREATE TRIGGER video_artifact_no_truncate
  BEFORE TRUNCATE ON "VideoArtifact"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_video_artifact_mutation();
