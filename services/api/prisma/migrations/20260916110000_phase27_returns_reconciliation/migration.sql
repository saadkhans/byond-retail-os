-- Phase 27 — returns, refunds and inventory reconciliation.
--
-- Adds the reverse flow: refund money movement against captured payments,
-- returns and settled-order cancellations that put goods BACK into stock,
-- cycle counts / stocktakes that reconcile the stock projection against the
-- ledger, and the shrink path that turns a CV-detected unexplained loss into
-- a recorded write-off.
--
-- The hardening at the bottom is the point of the phase. It pins, at the
-- DATABASE level, the two invariants the application code also enforces:
--
--   1. STOCK ONLY MOVES THROUGH THE LEDGER. A restocked return line and a
--      non-zero cycle-count variance are both REQUIRED to cite the
--      InventoryMovement they produced, and a shrink record cannot exist
--      without one. There is no way to record a stock change here without an
--      append-only ledger row behind it.
--   2. REFUNDS ARE BOUNDED. An intent can never report more refunded than it
--      captured, and a refund is never for a non-positive amount.
--
-- Nothing here changes existing behaviour: the only change to an existing
-- table is one NOT NULL DEFAULT 0 column on PaymentIntent and two new ledger
-- movement types that nothing writes yet.

-- AlterEnum
--   The ledger gains the two reverse-flow movement types. Postgres cannot use
--   a value added in the same transaction that added it, and nothing in this
--   migration writes a movement, so this is safe.
ALTER TYPE "InventoryMovementType" ADD VALUE 'RETURN_IN';
ALTER TYPE "InventoryMovementType" ADD VALUE 'SHRINK';

-- CreateEnum
CREATE TYPE "PaymentRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderReturnKind" AS ENUM ('CUSTOMER_RETURN', 'ORDER_CANCELLATION');

-- CreateEnum
CREATE TYPE "OrderReturnStatus" AS ENUM ('RECORDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "RefundSkipReason" AS ENUM ('NOT_REQUESTED', 'NO_CAPTURED_PAYMENT', 'NO_PRICEABLE_LINES', 'ALREADY_FULLY_REFUNDED');

-- CreateEnum
CREATE TYPE "CycleCountStatus" AS ENUM ('OPEN', 'RECONCILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShrinkSource" AS ENUM ('CV_DETECTED', 'OPERATOR');

-- AlterTable
ALTER TABLE "PaymentIntent" ADD COLUMN     "refundedAmountMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "captureId" TEXT,
    "status" "PaymentRefundStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "reason" TEXT,
    "providerRef" TEXT,
    "providerRefundRef" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReturn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "OrderReturnKind" NOT NULL,
    "status" "OrderReturnStatus" NOT NULL DEFAULT 'RECORDED',
    "reference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "restockedQuantity" INTEGER NOT NULL DEFAULT 0,
    "refundAmountMinor" INTEGER,
    "currencyCode" TEXT,
    "refundId" TEXT,
    "refundSkipReason" "RefundSkipReason",
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReturnLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "restocked" BOOLEAN NOT NULL DEFAULT true,
    "movementId" TEXT,
    "refundAmountMinor" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "CycleCountStatus" NOT NULL DEFAULT 'OPEN',
    "isFullStocktake" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "reconciledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CycleCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleCountLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cycleCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "countedQuantity" INTEGER NOT NULL,
    "systemQuantity" INTEGER,
    "ledgerQuantity" INTEGER,
    "varianceQuantity" INTEGER,
    "ledgerDriftQuantity" INTEGER,
    "movementId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CycleCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShrinkEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "visionEventId" TEXT,
    "source" "ShrinkSource" NOT NULL DEFAULT 'CV_DETECTED',
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShrinkEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_id_tenantId_key" ON "InventoryMovement"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_id_tenantId_key" ON "PaymentRefund"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_tenantId_idempotencyKey_key" ON "PaymentRefund"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentRefund_tenantId_intentId_createdAt_id_idx" ON "PaymentRefund"("tenantId", "intentId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PaymentRefund_tenantId_status_createdAt_id_idx" ON "PaymentRefund"("tenantId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReturn_id_tenantId_key" ON "OrderReturn"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReturn_tenantId_reference_key" ON "OrderReturn"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "OrderReturn_tenantId_orderId_createdAt_id_idx" ON "OrderReturn"("tenantId", "orderId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "OrderReturn_tenantId_status_createdAt_id_idx" ON "OrderReturn"("tenantId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReturnLine_id_tenantId_key" ON "OrderReturnLine"("id", "tenantId");

-- CreateIndex
CREATE INDEX "OrderReturnLine_tenantId_returnId_idx" ON "OrderReturnLine"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "OrderReturnLine_tenantId_orderLineId_idx" ON "OrderReturnLine"("tenantId", "orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "CycleCount_id_tenantId_key" ON "CycleCount"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CycleCount_tenantId_reference_key" ON "CycleCount"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "CycleCount_tenantId_locationId_status_idx" ON "CycleCount"("tenantId", "locationId", "status");

-- CreateIndex
CREATE INDEX "CycleCount_tenantId_status_createdAt_id_idx" ON "CycleCount"("tenantId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CycleCountLine_id_tenantId_key" ON "CycleCountLine"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CycleCountLine_tenantId_cycleCountId_productId_key" ON "CycleCountLine"("tenantId", "cycleCountId", "productId");

-- CreateIndex
CREATE INDEX "CycleCountLine_tenantId_cycleCountId_idx" ON "CycleCountLine"("tenantId", "cycleCountId");

-- CreateIndex
CREATE INDEX "CycleCountLine_tenantId_productId_idx" ON "CycleCountLine"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShrinkEvent_id_tenantId_key" ON "ShrinkEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ShrinkEvent_visionEventId_key" ON "ShrinkEvent"("visionEventId");

-- CreateIndex
CREATE INDEX "ShrinkEvent_tenantId_locationId_createdAt_id_idx" ON "ShrinkEvent"("tenantId", "locationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ShrinkEvent_tenantId_productId_createdAt_id_idx" ON "ShrinkEvent"("tenantId", "productId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "PaymentCapture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "PaymentRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "OrderReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnLine" ADD CONSTRAINT "OrderReturnLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCount" ADD CONSTRAINT "CycleCount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCount" ADD CONSTRAINT "CycleCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCount" ADD CONSTRAINT "CycleCount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCount" ADD CONSTRAINT "CycleCount_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountLine" ADD CONSTRAINT "CycleCountLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountLine" ADD CONSTRAINT "CycleCountLine_cycleCountId_fkey" FOREIGN KEY ("cycleCountId") REFERENCES "CycleCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountLine" ADD CONSTRAINT "CycleCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleCountLine" ADD CONSTRAINT "CycleCountLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShrinkEvent" ADD CONSTRAINT "ShrinkEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShrinkEvent" ADD CONSTRAINT "ShrinkEvent_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShrinkEvent" ADD CONSTRAINT "ShrinkEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShrinkEvent" ADD CONSTRAINT "ShrinkEvent_visionEventId_fkey" FOREIGN KEY ("visionEventId") REFERENCES "VisionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShrinkEvent" ADD CONSTRAINT "ShrinkEvent_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShrinkEvent" ADD CONSTRAINT "ShrinkEvent_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN HARDENING (beyond what Prisma can express)
-- ===========================================================================

-- 1. SAME-TENANT COMPOSITE FOREIGN KEYS.
--    The single-column FKs above accept ANY parent row; these make every
--    reverse-flow reference tenant-consistent at the database level, so a
--    tenant can never return another tenant's order line, count another
--    tenant's product, or cite another tenant's ledger movement — even if the
--    application layer were bypassed entirely.
--
--    User references are deliberately NOT covered, for the same reason as
--    every earlier phase: a platform admin acting in the platform-sandbox
--    tenant is a (platform user, sandbox tenant) pair that User(id, tenantId)
--    can never hold.

ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_intent_same_tenant_fkey"
  FOREIGN KEY ("intentId", "tenantId")
  REFERENCES "PaymentIntent"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_capture_same_tenant_fkey"
  FOREIGN KEY ("captureId", "tenantId")
  REFERENCES "PaymentCapture"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_order_same_tenant_fkey"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_refund_same_tenant_fkey"
  FOREIGN KEY ("refundId", "tenantId")
  REFERENCES "PaymentRefund"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_return_same_tenant_fkey"
  FOREIGN KEY ("returnId", "tenantId")
  REFERENCES "OrderReturn"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_order_line_same_tenant_fkey"
  FOREIGN KEY ("orderLineId", "tenantId")
  REFERENCES "OrderLine"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId")
  REFERENCES "Product"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_movement_same_tenant_fkey"
  FOREIGN KEY ("movementId", "tenantId")
  REFERENCES "InventoryMovement"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCount"
  ADD CONSTRAINT "CycleCount_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId")
  REFERENCES "Location"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_count_same_tenant_fkey"
  FOREIGN KEY ("cycleCountId", "tenantId")
  REFERENCES "CycleCount"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId")
  REFERENCES "Product"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_movement_same_tenant_fkey"
  FOREIGN KEY ("movementId", "tenantId")
  REFERENCES "InventoryMovement"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShrinkEvent"
  ADD CONSTRAINT "ShrinkEvent_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId")
  REFERENCES "Location"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShrinkEvent"
  ADD CONSTRAINT "ShrinkEvent_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId")
  REFERENCES "Product"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShrinkEvent"
  ADD CONSTRAINT "ShrinkEvent_vision_event_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId")
  REFERENCES "VisionEvent"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShrinkEvent"
  ADD CONSTRAINT "ShrinkEvent_movement_same_tenant_fkey"
  FOREIGN KEY ("movementId", "tenantId")
  REFERENCES "InventoryMovement"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. REFUNDS ARE BOUNDED AND NEVER NEGATIVE.
--    The service computes the ceiling under the intent advisory lock; this is
--    the backstop that no code path — present or future — can report more
--    money returned than was ever taken.
ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_refund_within_capture"
  CHECK ("refundedAmountMinor" >= 0 AND "refundedAmountMinor" <= "capturedAmountMinor");

ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_amount_positive"
  CHECK ("amountMinor" > 0);

--    A refund's status and its evidence move together: a settled refund
--    always carries when it settled, and a PENDING one never pretends to.
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_settlement_evidence"
  CHECK (
    ("status" = 'PENDING' AND "settledAt" IS NULL)
    OR ("status" IN ('SUCCEEDED', 'FAILED') AND "settledAt" IS NOT NULL)
  );

-- 3. STOCK REVERSAL ALWAYS WENT THROUGH THE LEDGER.
--    A return line that claims the goods went back on the shelf MUST cite the
--    InventoryMovement that put them there. There is therefore no way to
--    record a restock without an append-only ledger row behind it.
ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_restock_has_movement"
  CHECK ("restocked" = false OR "movementId" IS NOT NULL);

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "OrderReturnLine"
  ADD CONSTRAINT "OrderReturnLine_refund_amount_nonnegative"
  CHECK ("refundAmountMinor" IS NULL OR "refundAmountMinor" >= 0);

--    A return's status and its money never drift apart: RECORDED means no
--    refund was created, and every other state names the refund it created.
ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_refund_evidence"
  CHECK (
    ("status" = 'RECORDED' AND "refundId" IS NULL)
    OR ("status" <> 'RECORDED' AND "refundId" IS NOT NULL)
  );

ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_refund_amount_nonnegative"
  CHECK ("refundAmountMinor" IS NULL OR "refundAmountMinor" >= 0);

ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_restocked_quantity_nonnegative"
  CHECK ("restockedQuantity" >= 0);

-- 4. A CYCLE COUNT NEVER SETS STOCK.
--    The variance is DERIVED (counted minus the projection read under the
--    per-product lock), never an arbitrary number, and a non-zero variance
--    MUST cite the CORRECTION_IN/CORRECTION_OUT movement it became. Together
--    these make it impossible for a count to become a second source of truth:
--    the only way it can change stock is by appending to the ledger.
ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_counted_quantity_nonnegative"
  CHECK ("countedQuantity" >= 0);

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_variance_is_derived"
  CHECK (
    "varianceQuantity" IS NULL
    OR "systemQuantity" IS NULL
    OR "varianceQuantity" = "countedQuantity" - "systemQuantity"
  );

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_variance_has_movement"
  CHECK (
    "varianceQuantity" IS NULL
    OR "varianceQuantity" = 0
    OR "movementId" IS NOT NULL
  );

--    A reconciled count always says when it was reconciled, and a cancelled
--    one always says when it was abandoned.
ALTER TABLE "CycleCount"
  ADD CONSTRAINT "CycleCount_status_evidence"
  CHECK (
    ("status" = 'OPEN' AND "reconciledAt" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'RECONCILED' AND "reconciledAt" IS NOT NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "reconciledAt" IS NULL)
  );

-- 5. A SHRINK IS ALWAYS EVIDENCED.
--    A CV-detected write-off must name the observation that detected it
--    (`movementId` is already NOT NULL, so a shrink can never exist without
--    its ledger entry).
ALTER TABLE "ShrinkEvent"
  ADD CONSTRAINT "ShrinkEvent_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "ShrinkEvent"
  ADD CONSTRAINT "ShrinkEvent_cv_detected_has_observation"
  CHECK ("source" <> 'CV_DETECTED' OR "visionEventId" IS NOT NULL);
