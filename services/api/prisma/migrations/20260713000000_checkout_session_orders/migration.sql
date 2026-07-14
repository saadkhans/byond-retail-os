-- Phase 5: checkout sessions & order foundation.
--
-- NO payment capture in this phase: pricing/total columns are nullable
-- placeholders that stay NULL, and nothing here implies paid/captured.
-- Evidence/source columns are vendor-neutral lineage placeholders for future
-- CV/VLM adapter layers — no camera/model/vendor-specific data.

-- New ledger event type for checkout completion, and new audit actions for
-- session/order lifecycle transitions.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "InventoryMovementType" ADD VALUE 'SALE';
ALTER TYPE "AuditAction" ADD VALUE 'COMPLETE';
ALTER TYPE "AuditAction" ADD VALUE 'CANCEL';
ALTER TYPE "AuditAction" ADD VALUE 'EXPIRE';

-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('OPEN', 'ACTIVE', 'PENDING_REVIEW', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('MANUAL', 'ADMIN', 'DEVICE', 'VISION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EvidenceQuality" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "deviceId" TEXT,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "evidenceBundleId" TEXT,
    "visionEventId" TEXT,
    "vlmReviewId" TEXT,
    "evidenceScore" DOUBLE PRECISION,
    "evidenceQuality" "EvidenceQuality",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutSessionLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER,
    "lineTotalMinor" INTEGER,
    "currencyCode" TEXT,
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "evidenceBundleId" TEXT,
    "visionEventId" TEXT,
    "vlmReviewId" TEXT,
    "evidenceScore" DOUBLE PRECISION,
    "evidenceQuality" "EvidenceQuality",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSessionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "totalQuantity" INTEGER NOT NULL,
    "subtotalMinor" INTEGER,
    "totalMinor" INTEGER,
    "currencyCode" TEXT,
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "evidenceBundleId" TEXT,
    "visionEventId" TEXT,
    "vlmReviewId" TEXT,
    "evidenceScore" DOUBLE PRECISION,
    "evidenceQuality" "EvidenceQuality",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sessionLineId" TEXT,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER,
    "lineTotalMinor" INTEGER,
    "currencyCode" TEXT,
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "evidenceBundleId" TEXT,
    "visionEventId" TEXT,
    "vlmReviewId" TEXT,
    "evidenceScore" DOUBLE PRECISION,
    "evidenceQuality" "EvidenceQuality",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_id_tenantId_key" ON "CheckoutSession"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_tenantId_idempotencyKey_key" ON "CheckoutSession"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CheckoutSession_tenantId_status_startedAt_id_idx" ON "CheckoutSession"("tenantId", "status", "startedAt", "id");

-- CreateIndex
CREATE INDEX "CheckoutSession_tenantId_locationId_idx" ON "CheckoutSession"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "CheckoutSession_tenantId_unitId_idx" ON "CheckoutSession"("tenantId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSessionLine_id_tenantId_key" ON "CheckoutSessionLine"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSessionLine_tenantId_sessionId_productId_key" ON "CheckoutSessionLine"("tenantId", "sessionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSessionLine_tenantId_idempotencyKey_key" ON "CheckoutSessionLine"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_tenantId_sessionId_createdAt_id_idx" ON "CheckoutSessionLine"("tenantId", "sessionId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_checkoutSessionId_key" ON "Order"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_tenantId_key" ON "Order"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_orderNumber_key" ON "Order"("tenantId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_checkoutSessionId_key" ON "Order"("tenantId", "checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_idempotencyKey_key" ON "Order"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_tenantId_status_placedAt_id_idx" ON "Order"("tenantId", "status", "placedAt", "id");

-- CreateIndex
CREATE INDEX "Order_tenantId_locationId_idx" ON "Order"("tenantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_id_tenantId_key" ON "OrderLine"("id", "tenantId");

-- CreateIndex
CREATE INDEX "OrderLine_tenantId_orderId_idx" ON "OrderLine"("tenantId", "orderId");

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_sessionLineId_fkey" FOREIGN KEY ("sessionLineId") REFERENCES "CheckoutSessionLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- 1. Line quantities are always positive (a zero/negative basket or order
--    line is meaningless), and an order always carries at least one unit.
--    The application validates first; these CHECKs backstop any future code
--    path that forgets to.
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_quantity_positive_check"
  CHECK ("quantity" >= 1);
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_quantity_positive_check"
  CHECK ("quantity" >= 1);
ALTER TABLE "Order" ADD CONSTRAINT "Order_totalQuantity_positive_check"
  CHECK ("totalQuantity" >= 1);

-- 2. Evidence scores are normalized confidences: NULL (absent) or in [0, 1].
--    Vendor-neutral by construction — adapters must normalize before writing.
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_evidenceScore_range_check"
  CHECK ("evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1));
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_evidenceScore_range_check"
  CHECK ("evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1));
ALTER TABLE "Order" ADD CONSTRAINT "Order_evidenceScore_range_check"
  CHECK ("evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1));
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_evidenceScore_range_check"
  CHECK ("evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1));

-- 3. Cross-tenant reference integrity at the database level (same pattern as
--    Phase 3/4): a session can never live in another tenant's store/unit or
--    reference another tenant's device; lines can never reference another
--    tenant's session/product; orders can never reference another tenant's
--    session/store/unit; order lines can never reference another tenant's
--    order/product/basket line — even if an unscoped id ever slipped through
--    application code. (MATCH SIMPLE skips the check when the nullable column
--    is NULL — exactly what we want for optional references.)
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_device_same_tenant_fkey"
  FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_session_same_tenant_fkey"
  FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_session_same_tenant_fkey"
  FOREIGN KEY ("checkoutSessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_order_same_tenant_fkey"
  FOREIGN KEY ("orderId", "tenantId") REFERENCES "Order"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_sessionLine_same_tenant_fkey"
  FOREIGN KEY ("sessionLineId", "tenantId") REFERENCES "CheckoutSessionLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
