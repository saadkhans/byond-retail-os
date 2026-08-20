-- Phase 17 — camera calibration & pilot hardening (SHADOW ONLY).
-- Calibration profiles + normalized shelf/interaction/ignore zones for
-- one camera source, used only to make live CV testing more reliable.
-- No RTSP URL, file path, credential slot, raw frame, or raw video is
-- ever stored here; nothing in this phase touches checkout, order,
-- payment, or inventory state.

-- CreateEnum
CREATE TYPE "CameraCalibrationProfileStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "CameraCalibrationOrientation" AS ENUM ('LANDSCAPE', 'PORTRAIT', 'UNKNOWN');
CREATE TYPE "CameraCalibrationMount" AS ENUM ('OVERHEAD', 'FRONT_SHELF', 'ANGLED_SHELF', 'UNKNOWN');
CREATE TYPE "CameraCalibrationZoneType" AS ENUM ('SHELF_ZONE', 'INTERACTION_ZONE', 'IGNORE_ZONE', 'ENTRY_EXIT_ZONE');

-- CreateTable
CREATE TABLE "CameraCalibrationProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraSourceId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "status" "CameraCalibrationProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "calibrationVersion" INTEGER NOT NULL DEFAULT 1,
    "frameWidth" INTEGER,
    "frameHeight" INTEGER,
    "orientation" "CameraCalibrationOrientation" NOT NULL DEFAULT 'UNKNOWN',
    "cameraMount" "CameraCalibrationMount" NOT NULL DEFAULT 'UNKNOWN',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "CameraCalibrationProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CameraCalibrationZone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "calibrationProfileId" TEXT NOT NULL,
    "cameraSourceId" TEXT NOT NULL,
    "zoneType" "CameraCalibrationZoneType" NOT NULL,
    "label" TEXT NOT NULL,
    "polygon" JSONB NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraCalibrationZone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CameraCalibrationZoneProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expectedSku" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraCalibrationZoneProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CameraCalibrationProfile_id_tenantId_key" ON "CameraCalibrationProfile"("id", "tenantId");
CREATE INDEX "CameraCalibrationProfile_tenantId_cameraSourceId_createdAt_idx" ON "CameraCalibrationProfile"("tenantId", "cameraSourceId", "createdAt" DESC);
CREATE INDEX "CameraCalibrationProfile_tenantId_status_idx" ON "CameraCalibrationProfile"("tenantId", "status");
-- At most ONE ACTIVE calibration profile per camera source (partial
-- unique — Prisma cannot express the WHERE clause; the activation
-- transaction archives the previous ACTIVE profile under an advisory
-- lock, and this index backstops the race at the database level).
CREATE UNIQUE INDEX "CameraCalibrationProfile_one_active_per_source_key" ON "CameraCalibrationProfile"("tenantId", "cameraSourceId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "CameraCalibrationZone_id_tenantId_key" ON "CameraCalibrationZone"("id", "tenantId");
CREATE INDEX "CameraCalibrationZone_tenantId_calibrationProfileId_sortOrd_idx" ON "CameraCalibrationZone"("tenantId", "calibrationProfileId", "sortOrder");
CREATE UNIQUE INDEX "CameraCalibrationZoneProduct_id_tenantId_key" ON "CameraCalibrationZoneProduct"("id", "tenantId");
CREATE UNIQUE INDEX "CameraCalibrationZoneProduct_tenantId_zoneId_productId_key" ON "CameraCalibrationZoneProduct"("tenantId", "zoneId", "productId");
CREATE INDEX "CameraCalibrationZoneProduct_tenantId_productId_idx" ON "CameraCalibrationZoneProduct"("tenantId", "productId");

-- AddForeignKey
ALTER TABLE "CameraCalibrationProfile" ADD CONSTRAINT "CameraCalibrationProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Same-tenant composite relations (AGENTS.md: tenancy / Codex P1): the
-- FK itself carries the tenant, so a malformed row can never resolve
-- another tenant's camera source, store, zone, or product.
ALTER TABLE "CameraCalibrationProfile" ADD CONSTRAINT "CameraCalibrationProfile_cameraSourceId_tenantId_fkey" FOREIGN KEY ("cameraSourceId", "tenantId") REFERENCES "CameraSource"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationProfile" ADD CONSTRAINT "CameraCalibrationProfile_locationId_tenantId_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationZone" ADD CONSTRAINT "CameraCalibrationZone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationZone" ADD CONSTRAINT "CameraCalibrationZone_calibrationProfileId_tenantId_fkey" FOREIGN KEY ("calibrationProfileId", "tenantId") REFERENCES "CameraCalibrationProfile"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationZone" ADD CONSTRAINT "CameraCalibrationZone_cameraSourceId_tenantId_fkey" FOREIGN KEY ("cameraSourceId", "tenantId") REFERENCES "CameraSource"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationZoneProduct" ADD CONSTRAINT "CameraCalibrationZoneProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationZoneProduct" ADD CONSTRAINT "CameraCalibrationZoneProduct_zoneId_tenantId_fkey" FOREIGN KEY ("zoneId", "tenantId") REFERENCES "CameraCalibrationZone"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CameraCalibrationZoneProduct" ADD CONSTRAINT "CameraCalibrationZoneProduct_productId_tenantId_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
