-- CreateEnum
CREATE TYPE "FusionPolicyResult" AS ENUM ('AUTO_PROPOSE', 'NEEDS_VLM', 'NEEDS_HUMAN_REVIEW', 'UNKNOWN_PRODUCT', 'FAILED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "nameArabic" TEXT;

-- CreateTable
CREATE TABLE "ProductReferenceEmbedding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referenceImageId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "vector" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReferenceEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupFusionRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "policy" "FusionPolicyResult" NOT NULL,
    "fusedTopSku" TEXT,
    "fusedTopScore" DOUBLE PRECISION,
    "scoreMargin" DOUBLE PRECISION,
    "evidence" JSONB NOT NULL,
    "processingMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupFusionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductReferenceEmbedding_tenantId_modelKey_idx" ON "ProductReferenceEmbedding"("tenantId", "modelKey");

-- CreateIndex
CREATE INDEX "ProductReferenceEmbedding_tenantId_productId_idx" ON "ProductReferenceEmbedding"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReferenceEmbedding_referenceImageId_modelKey_key" ON "ProductReferenceEmbedding"("referenceImageId", "modelKey");

-- CreateIndex
CREATE INDEX "PickupFusionRun_tenantId_videoAssetId_createdAt_idx" ON "PickupFusionRun"("tenantId", "videoAssetId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ProductReferenceEmbedding" ADD CONSTRAINT "ProductReferenceEmbedding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReferenceEmbedding" ADD CONSTRAINT "ProductReferenceEmbedding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReferenceEmbedding" ADD CONSTRAINT "ProductReferenceEmbedding_referenceImageId_fkey" FOREIGN KEY ("referenceImageId") REFERENCES "ProductReferenceImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "PickupFusionRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "PickupFusionRun_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
