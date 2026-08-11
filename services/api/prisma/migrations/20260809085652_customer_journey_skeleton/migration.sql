-- CreateEnum
CREATE TYPE "CustomerJourneyStatus" AS ENUM ('OPEN', 'EXITED', 'RECONCILED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "CustomerJourneyEventType" AS ENUM ('ENTRY', 'EXIT', 'SHELF_INTERACTION', 'PRODUCT_PICKUP', 'PRODUCT_RETURN', 'REVIEW_REQUIRED');

-- CreateTable
CREATE TABLE "CustomerJourney" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "unitId" TEXT,
    "status" "CustomerJourneyStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerJourneyEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "eventType" "CustomerJourneyEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "productId" TEXT,
    "sku" TEXT,
    "productName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "matchScore" DOUBLE PRECISION,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "videoAssetId" TEXT,
    "fusionRunId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerJourneyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerJourney_tenantId_status_startedAt_idx" ON "CustomerJourney"("tenantId", "status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "CustomerJourneyEvent_tenantId_journeyId_occurredAt_idx" ON "CustomerJourneyEvent"("tenantId", "journeyId", "occurredAt");

-- AddForeignKey
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourneyEvent" ADD CONSTRAINT "CustomerJourneyEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourneyEvent" ADD CONSTRAINT "CustomerJourneyEvent_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "CustomerJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourneyEvent" ADD CONSTRAINT "CustomerJourneyEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
