-- Phase 19 — pretrained retail vision adapters + planogram-aware SKU
-- narrowing. Shadow evidence only: planograms are a SOFT scoring prior
-- and pretrained runs are local-only normalized evidence. Nothing here
-- references checkout, order, payment, settlement, or inventory tables.

-- CreateEnum
CREATE TYPE "PlanogramRackStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "PretrainedVisionRunStatus" AS ENUM ('COMPLETED', 'PROVIDER_UNAVAILABLE', 'FAILED');

-- CreateTable
CREATE TABLE "PlanogramRack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "rackCode" TEXT NOT NULL,
    "name" TEXT,
    "rows" INTEGER NOT NULL,
    "columns" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanogramRackStatus" NOT NULL DEFAULT 'ACTIVE',
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanogramRack_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlanogramCellAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rackId" TEXT NOT NULL,
    "cellCode" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "columnIndex" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "skuCodeSnapshot" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "facingCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanogramCellAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PretrainedVisionRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "PretrainedVisionRunStatus" NOT NULL,
    "planogramRackId" TEXT,
    "planogramVersion" INTEGER,
    "evidence" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PretrainedVisionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanogramRack_id_tenantId_key" ON "PlanogramRack"("id", "tenantId");
CREATE INDEX "PlanogramRack_tenantId_locationId_rackCode_status_idx" ON "PlanogramRack"("tenantId", "locationId", "rackCode", "status");
CREATE UNIQUE INDEX "PlanogramCellAssignment_id_tenantId_key" ON "PlanogramCellAssignment"("id", "tenantId");
CREATE UNIQUE INDEX "PlanogramCellAssignment_rackId_cellCode_productId_key" ON "PlanogramCellAssignment"("rackId", "cellCode", "productId");
CREATE INDEX "PlanogramCellAssignment_tenantId_rackId_idx" ON "PlanogramCellAssignment"("tenantId", "rackId");
CREATE INDEX "PlanogramCellAssignment_tenantId_productId_idx" ON "PlanogramCellAssignment"("tenantId", "productId");
CREATE UNIQUE INDEX "PretrainedVisionRun_id_tenantId_key" ON "PretrainedVisionRun"("id", "tenantId");
CREATE INDEX "PretrainedVisionRun_tenantId_videoAssetId_createdAt_idx" ON "PretrainedVisionRun"("tenantId", "videoAssetId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "PlanogramRack" ADD CONSTRAINT "PlanogramRack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanogramRack" ADD CONSTRAINT "PlanogramRack_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanogramCellAssignment" ADD CONSTRAINT "PlanogramCellAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanogramCellAssignment" ADD CONSTRAINT "PlanogramCellAssignment_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "PlanogramRack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanogramCellAssignment" ADD CONSTRAINT "PlanogramCellAssignment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PretrainedVisionRun" ADD CONSTRAINT "PretrainedVisionRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PretrainedVisionRun" ADD CONSTRAINT "PretrainedVisionRun_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
