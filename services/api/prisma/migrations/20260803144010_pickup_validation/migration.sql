-- CreateEnum
CREATE TYPE "GroundTruthEventKind" AS ENUM ('PICKUP', 'RETURN', 'NONE');

-- CreateTable
CREATE TABLE "ProductReferenceImage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReferenceImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoGroundTruth" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "eventKind" "GroundTruthEventKind" NOT NULL,
    "productId" TEXT,
    "actualTimestampMs" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoGroundTruth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductReferenceImage_tenantId_productId_idx" ON "ProductReferenceImage"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReferenceImage_tenantId_productId_checksumSha256_key" ON "ProductReferenceImage"("tenantId", "productId", "checksumSha256");

-- CreateIndex
CREATE UNIQUE INDEX "VideoGroundTruth_videoAssetId_key" ON "VideoGroundTruth"("videoAssetId");

-- CreateIndex
CREATE INDEX "VideoGroundTruth_tenantId_productId_idx" ON "VideoGroundTruth"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoGroundTruth_tenantId_videoAssetId_key" ON "VideoGroundTruth"("tenantId", "videoAssetId");

-- AddForeignKey
ALTER TABLE "ProductReferenceImage" ADD CONSTRAINT "ProductReferenceImage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReferenceImage" ADD CONSTRAINT "ProductReferenceImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoGroundTruth" ADD CONSTRAINT "VideoGroundTruth_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoGroundTruth" ADD CONSTRAINT "VideoGroundTruth_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoGroundTruth" ADD CONSTRAINT "VideoGroundTruth_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
