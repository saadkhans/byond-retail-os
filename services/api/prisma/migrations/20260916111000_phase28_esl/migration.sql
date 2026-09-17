-- Phase 28 — Electronic shelf labels. A vendor gateway owns labels; a label
-- shows the price that a PriceBookVersion activation put in force. BYOND
-- never stores a vendor credential: EslGateway.credentialRef is an opaque
-- configuration key, and the service rejects credential-shaped values in it
-- and in `metadata` (AGENTS.md / SECURITY.md secret-handling rules).
--
-- Propagation is a database-backed queue using the same idiom as the Phase 9
-- inference queue: lease + attempt budget + fencing token, with `nextAttemptAt`
-- gating backoff and a tenant-scoped idempotencyKey making a replayed
-- activation a no-op.

-- CreateEnum
CREATE TYPE "EslGatewayStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "EslLabelStatus" AS ENUM ('UNBOUND', 'BOUND', 'RETIRED');

-- CreateEnum
CREATE TYPE "EslUpdateJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EslUpdateTrigger" AS ENUM ('PRICE_ACTIVATION', 'MANUAL_RERENDER', 'LABEL_BOUND', 'RECONCILIATION');

-- CreateEnum
CREATE TYPE "EslUpdateErrorCode" AS ENUM ('GATEWAY_UNREACHABLE', 'GATEWAY_DISABLED', 'LABEL_UNREACHABLE', 'LABEL_RETIRED', 'VENDOR_REJECTED', 'VENDOR_TIMEOUT', 'CONTENT_UNRESOLVABLE', 'UNKNOWN_VENDOR', 'LEASE_EXPIRED');

-- CreateTable
CREATE TABLE "EslGateway" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendorCode" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "EslGatewayStatus" NOT NULL DEFAULT 'PENDING',
    "credentialRef" TEXT,
    "metadata" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "EslGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EslLabel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "vendorLabelId" TEXT NOT NULL,
    "productId" TEXT,
    "cellAssignmentId" TEXT,
    "status" "EslLabelStatus" NOT NULL DEFAULT 'UNBOUND',
    "batteryPercent" INTEGER,
    "signalPercent" INTEGER,
    "lastRenderedAt" TIMESTAMP(3),
    "renderedVersionId" TEXT,
    "renderedContentHash" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "EslLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EslUpdateJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "trigger" "EslUpdateTrigger" NOT NULL,
    "priceBookVersionId" TEXT,
    "status" "EslUpdateJobStatus" NOT NULL DEFAULT 'QUEUED',
    "contentHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAttempt" INTEGER,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" "EslUpdateErrorCode",
    "lastErrorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "EslUpdateJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EslGateway_tenantId_status_idx" ON "EslGateway"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EslGateway_tenantId_locationId_status_idx" ON "EslGateway"("tenantId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EslGateway_id_tenantId_key" ON "EslGateway"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EslGateway_tenantId_code_key" ON "EslGateway"("tenantId", "code");

-- CreateIndex
CREATE INDEX "EslLabel_tenantId_status_idx" ON "EslLabel"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EslLabel_tenantId_productId_idx" ON "EslLabel"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "EslLabel_tenantId_gatewayId_status_idx" ON "EslLabel"("tenantId", "gatewayId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EslLabel_id_tenantId_key" ON "EslLabel"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EslLabel_gatewayId_vendorLabelId_key" ON "EslLabel"("gatewayId", "vendorLabelId");

-- CreateIndex
CREATE INDEX "EslUpdateJob_tenantId_status_nextAttemptAt_requestedAt_id_idx" ON "EslUpdateJob"("tenantId", "status", "nextAttemptAt", "requestedAt", "id");

-- CreateIndex
CREATE INDEX "EslUpdateJob_tenantId_labelId_status_idx" ON "EslUpdateJob"("tenantId", "labelId", "status");

-- CreateIndex
CREATE INDEX "EslUpdateJob_tenantId_gatewayId_status_idx" ON "EslUpdateJob"("tenantId", "gatewayId", "status");

-- CreateIndex
CREATE INDEX "EslUpdateJob_tenantId_priceBookVersionId_idx" ON "EslUpdateJob"("tenantId", "priceBookVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "EslUpdateJob_id_tenantId_key" ON "EslUpdateJob"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EslUpdateJob_tenantId_idempotencyKey_key" ON "EslUpdateJob"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "EslGateway" ADD CONSTRAINT "EslGateway_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslGateway" ADD CONSTRAINT "EslGateway_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslGateway" ADD CONSTRAINT "EslGateway_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "EslGateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_cellAssignmentId_fkey" FOREIGN KEY ("cellAssignmentId") REFERENCES "PlanogramCellAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_renderedVersionId_fkey" FOREIGN KEY ("renderedVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "EslLabel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "EslGateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_priceBookVersionId_fkey" FOREIGN KEY ("priceBookVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Value constraints the DTOs and the service also enforce; these are the
-- backstop, in the style of the Phase 25 price constraints.
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_batteryPercent_range"
  CHECK ("batteryPercent" IS NULL OR ("batteryPercent" >= 0 AND "batteryPercent" <= 100));
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_signalPercent_range"
  CHECK ("signalPercent" IS NULL OR ("signalPercent" >= 0 AND "signalPercent" <= 100));
-- A label that has rendered something must say WHEN, so reconciliation can
-- never mistake "never pushed" for "pushed at an unknown time".
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_rendered_pair"
  CHECK (("renderedContentHash" IS NULL) = ("lastRenderedAt" IS NULL));
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_attempts_non_negative"
  CHECK ("attempts" >= 0);
-- A claimed attempt only exists while a lease does, and vice versa: the two
-- are written together on claim and cleared together on completion.
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_lease_pair"
  CHECK (("claimedAttempt" IS NULL) = ("leaseExpiresAt" IS NULL));

-- Same-tenant composite foreign keys. The single-column FKs above only prove
-- the referenced row EXISTS; these prove it belongs to the SAME tenant, so a
-- cross-tenant id can never be stitched into a label or a job even if
-- application code slipped. (A composite FK with a NULL column is satisfied
-- automatically, which is what we want for optional refs.)
ALTER TABLE "EslGateway" ADD CONSTRAINT "EslGateway_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslGateway" ADD CONSTRAINT "EslGateway_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_gateway_same_tenant_fkey"
  FOREIGN KEY ("gatewayId", "tenantId") REFERENCES "EslGateway"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_cell_same_tenant_fkey"
  FOREIGN KEY ("cellAssignmentId", "tenantId") REFERENCES "PlanogramCellAssignment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_renderedVersion_same_tenant_fkey"
  FOREIGN KEY ("renderedVersionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslLabel" ADD CONSTRAINT "EslLabel_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_label_same_tenant_fkey"
  FOREIGN KEY ("labelId", "tenantId") REFERENCES "EslLabel"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_gateway_same_tenant_fkey"
  FOREIGN KEY ("gatewayId", "tenantId") REFERENCES "EslGateway"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_priceVersion_same_tenant_fkey"
  FOREIGN KEY ("priceBookVersionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EslUpdateJob" ADD CONSTRAINT "EslUpdateJob_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
