-- Phase 25 — Pricing. Versioned, auditable, reversible prices (AGENTS.md
-- hard rule). A price is never a mutable column: it is an immutable
-- PriceBookEntry inside a PriceBookVersion, and changing a price means
-- creating a NEW version. Activation closes the previous version's effective
-- window; rollback copies an old version forward. Nothing here rewrites or
-- deletes price history.

-- New audit actions for the two price transitions that have no generic
-- equivalent: activating a version (prices actually change) and rolling back
-- to an earlier one.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "AuditAction" ADD VALUE 'PRICE_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'ROLLBACK';

-- CreateEnum
CREATE TYPE "PriceBookStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PriceBookVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PriceChangeReason" AS ENUM ('INITIAL', 'PRICE_CHANGE', 'PROMOTION_BASE', 'CORRECTION', 'ROLLBACK');

-- CreateTable
CREATE TABLE "PriceBook" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "locationId" TEXT,
    "status" "PriceBookStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "priceBookId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "PriceBookVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "reason" "PriceChangeReason" NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "supersededByVersionId" TEXT,
    "rolledBackFromVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceBookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBook_tenantId_status_idx" ON "PriceBook"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PriceBook_tenantId_locationId_status_idx" ON "PriceBook"("tenantId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_id_tenantId_key" ON "PriceBook"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_tenantId_code_key" ON "PriceBook"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookVersion_supersededByVersionId_key" ON "PriceBookVersion"("supersededByVersionId");

-- CreateIndex
CREATE INDEX "PriceBookVersion_tenantId_priceBookId_status_idx" ON "PriceBookVersion"("tenantId", "priceBookId", "status");

-- CreateIndex
CREATE INDEX "PriceBookVersion_tenantId_priceBookId_effectiveFrom_idx" ON "PriceBookVersion"("tenantId", "priceBookId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookVersion_id_tenantId_key" ON "PriceBookVersion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookVersion_priceBookId_versionNumber_key" ON "PriceBookVersion"("priceBookId", "versionNumber");

-- CreateIndex
CREATE INDEX "PriceBookEntry_tenantId_productId_idx" ON "PriceBookEntry"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "PriceBookEntry_tenantId_versionId_idx" ON "PriceBookEntry"("tenantId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookEntry_id_tenantId_key" ON "PriceBookEntry"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookEntry_versionId_productId_key" ON "PriceBookEntry"("versionId", "productId");

-- AddForeignKey
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_supersededByVersionId_fkey" FOREIGN KEY ("supersededByVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_rolledBackFromVersionId_fkey" FOREIGN KEY ("rolledBackFromVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookEntry" ADD CONSTRAINT "PriceBookEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookEntry" ADD CONSTRAINT "PriceBookEntry_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PriceBookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookEntry" ADD CONSTRAINT "PriceBookEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express in schema.prisma, so they live here and
-- are the LAST line of defence behind the DTOs and the service.
-- ---------------------------------------------------------------------------

-- 1. At most ONE ACTIVE version per price book. This is the invariant that
--    makes "the current price" well defined: a partial unique index over
--    "priceBookId" restricted to ACTIVE rows. Superseded and draft versions
--    are exempt, so a book accumulates unlimited history while never having
--    two current versions — even if two activations race.
CREATE UNIQUE INDEX "PriceBookVersion_active_book_key"
  ON "PriceBookVersion"("priceBookId")
  WHERE "status" = 'ACTIVE';

-- 2. Prices are never negative, and a version's effective window never runs
--    backwards. Both are enforced in the service; the CHECKs make a bug
--    there a failed write rather than corrupt pricing data.
ALTER TABLE "PriceBookEntry" ADD CONSTRAINT "PriceBookEntry_unitPriceMinor_nonnegative"
  CHECK ("unitPriceMinor" >= 0);
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_effective_window_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_versionNumber_positive"
  CHECK ("versionNumber" >= 1);

-- 3. A version can neither supersede nor be a rollback of itself.
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_no_self_supersession"
  CHECK ("supersededByVersionId" IS NULL OR "supersededByVersionId" <> "id");
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_no_self_rollback"
  CHECK ("rolledBackFromVersionId" IS NULL OR "rolledBackFromVersionId" <> "id");

-- 4. Same-tenant composite foreign keys. The single-column FKs above only
--    prove the referenced row EXISTS; these prove it belongs to the SAME
--    tenant, so a cross-tenant id can never be stitched into a price book
--    even if application code slipped. (A composite FK with a NULL column is
--    satisfied automatically, which is what we want for optional refs.)
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_book_same_tenant_fkey"
  FOREIGN KEY ("priceBookId", "tenantId") REFERENCES "PriceBook"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_superseded_same_tenant_fkey"
  FOREIGN KEY ("supersededByVersionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_rollback_same_tenant_fkey"
  FOREIGN KEY ("rolledBackFromVersionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBookEntry" ADD CONSTRAINT "PriceBookEntry_version_same_tenant_fkey"
  FOREIGN KEY ("versionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceBookEntry" ADD CONSTRAINT "PriceBookEntry_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
