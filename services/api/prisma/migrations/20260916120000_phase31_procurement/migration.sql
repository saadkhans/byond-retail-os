-- Phase 31 — Procurement: suppliers, purchase orders and goods receipts.
--
-- Receiving stock is an ordinary append-only ledger movement: a GoodsReceipt
-- posts RECEIPT rows through the same applyMovement path every other stock
-- change uses, and GoodsReceiptLine.inventoryMovementId records exactly which
-- movement admitted the units. No table here stores a stock quantity.
--
-- Ordered-vs-received is a projection over GoodsReceiptLine, not a counter on
-- PurchaseOrderLine, so a receipt can never drift from the ledger it wrote.
--
-- The composite (id, tenantId) foreign keys and CHECK constraints at the end
-- are hand-written: Prisma cannot express either, and they are what make a
-- cross-tenant stitch or a negative/implausible quantity structurally
-- impossible rather than merely rejected by application code.

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoodsReceiptDiscrepancy" AS ENUM ('NONE', 'SHORT_DELIVERY', 'OVER_DELIVERY', 'DAMAGED', 'SUBSTITUTED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'RECEIVE';

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "packSize" INTEGER NOT NULL DEFAULT 1,
    "unitCostMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "leadTimeDays" INTEGER,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProductCost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "unitCostMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "packSize" INTEGER NOT NULL,
    "reason" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currencyCode" TEXT NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "totalCostMinor" INTEGER,
    "notes" TEXT,
    "externalReference" TEXT,
    "createdById" TEXT,
    "submittedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierProductId" TEXT,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "packSize" INTEGER NOT NULL DEFAULT 1,
    "unitCostMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "deliveryNote" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "receivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantityReceived" INTEGER NOT NULL,
    "packSize" INTEGER NOT NULL DEFAULT 1,
    "unitsReceived" INTEGER NOT NULL,
    "discrepancy" "GoodsReceiptDiscrepancy" NOT NULL DEFAULT 'NONE',
    "discrepancyNote" TEXT,
    "inventoryMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_tenantId_status_idx" ON "Supplier"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_name_idx" ON "Supplier"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_code_key" ON "Supplier"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_id_tenantId_key" ON "Supplier"("id", "tenantId");

-- CreateIndex
CREATE INDEX "SupplierProduct_tenantId_productId_idx" ON "SupplierProduct"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "SupplierProduct_tenantId_supplierId_idx" ON "SupplierProduct"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_id_tenantId_key" ON "SupplierProduct"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_productId_key" ON "SupplierProduct"("supplierId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_supplierSku_key" ON "SupplierProduct"("supplierId", "supplierSku");

-- CreateIndex
CREATE INDEX "SupplierProductCost_tenantId_supplierProductId_recordedAt_idx" ON "SupplierProductCost"("tenantId", "supplierProductId", "recordedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProductCost_id_tenantId_key" ON "SupplierProductCost"("id", "tenantId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_status_createdAt_idx" ON "PurchaseOrder"("tenantId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_supplierId_idx" ON "PurchaseOrder"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_tenantId_locationId_idx" ON "PurchaseOrder"("tenantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_reference_key" ON "PurchaseOrder"("tenantId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_id_tenantId_key" ON "PurchaseOrder"("id", "tenantId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_tenantId_purchaseOrderId_idx" ON "PurchaseOrderLine"("tenantId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_tenantId_productId_idx" ON "PurchaseOrderLine"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_id_tenantId_key" ON "PurchaseOrderLine"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_purchaseOrderId_productId_key" ON "PurchaseOrderLine"("purchaseOrderId", "productId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_tenantId_purchaseOrderId_receivedAt_idx" ON "GoodsReceipt"("tenantId", "purchaseOrderId", "receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_reference_key" ON "GoodsReceipt"("tenantId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_idempotencyKey_key" ON "GoodsReceipt"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_id_tenantId_key" ON "GoodsReceipt"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_inventoryMovementId_key" ON "GoodsReceiptLine"("inventoryMovementId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_tenantId_goodsReceiptId_idx" ON "GoodsReceiptLine"("tenantId", "goodsReceiptId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_tenantId_purchaseOrderLineId_idx" ON "GoodsReceiptLine"("tenantId", "purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_tenantId_productId_idx" ON "GoodsReceiptLine"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_id_tenantId_key" ON "GoodsReceiptLine"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_goodsReceiptId_purchaseOrderLineId_key" ON "GoodsReceiptLine"("goodsReceiptId", "purchaseOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_id_tenantId_key" ON "InventoryMovement"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_inventoryMovementId_fkey" FOREIGN KEY ("inventoryMovementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SAME-TENANT COMPOSITE FOREIGN KEYS (hand-written; Prisma cannot express
-- them). The single-column keys Prisma generated above only prove the
-- referenced row EXISTS; these prove it belongs to the SAME tenant, so a
-- cross-tenant id can never be stitched into a purchase order or a receipt
-- even if application code slipped. (A composite FK with a NULL column is
-- satisfied automatically, which is what we want for optional references.)
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplier_same_tenant_fkey"
  FOREIGN KEY ("supplierId", "tenantId") REFERENCES "Supplier"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_supplierProduct_same_tenant_fkey"
  FOREIGN KEY ("supplierProductId", "tenantId") REFERENCES "SupplierProduct"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_recordedBy_same_tenant_fkey"
  FOREIGN KEY ("recordedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplier_same_tenant_fkey"
  FOREIGN KEY ("supplierId", "tenantId") REFERENCES "Supplier"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_submittedBy_same_tenant_fkey"
  FOREIGN KEY ("submittedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_order_same_tenant_fkey"
  FOREIGN KEY ("purchaseOrderId", "tenantId") REFERENCES "PurchaseOrder"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_supplierProduct_same_tenant_fkey"
  FOREIGN KEY ("supplierProductId", "tenantId") REFERENCES "SupplierProduct"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_order_same_tenant_fkey"
  FOREIGN KEY ("purchaseOrderId", "tenantId") REFERENCES "PurchaseOrder"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_receivedBy_same_tenant_fkey"
  FOREIGN KEY ("receivedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receipt_same_tenant_fkey"
  FOREIGN KEY ("goodsReceiptId", "tenantId") REFERENCES "GoodsReceipt"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_orderLine_same_tenant_fkey"
  FOREIGN KEY ("purchaseOrderLineId", "tenantId") REFERENCES "PurchaseOrderLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The ledger bridge: the movement a receipt line points at must belong to the
-- same tenant as the line. Enabled by the (id, tenantId) index added to
-- InventoryMovement above.
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_movement_same_tenant_fkey"
  FOREIGN KEY ("inventoryMovementId", "tenantId") REFERENCES "InventoryMovement"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DOMAIN CHECKS (hand-written; Prisma has no CHECK support). The service
-- validates all of these, so a violation here means a bug got past it — which
-- is exactly when a database constraint earns its keep.
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_packSize_positive"
  CHECK ("packSize" >= 1);
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_cost_non_negative"
  CHECK ("unitCostMinor" >= 0);

ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_packSize_positive"
  CHECK ("packSize" >= 1);
ALTER TABLE "SupplierProductCost" ADD CONSTRAINT "SupplierProductCost_cost_non_negative"
  CHECK ("unitCostMinor" >= 0);

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_total_non_negative"
  CHECK ("totalCostMinor" IS NULL OR "totalCostMinor" >= 0);

ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_quantity_positive"
  CHECK ("quantityOrdered" >= 1);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_packSize_positive"
  CHECK ("packSize" >= 1);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_cost_non_negative"
  CHECK ("unitCostMinor" >= 0);

-- A receipt line may accept nothing (zero packs) but never a negative amount,
-- and unitsReceived must be exactly packs x packSize so the ledger delta can
-- always be recomputed from the row.
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_quantity_non_negative"
  CHECK ("quantityReceived" >= 0);
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_packSize_positive"
  CHECK ("packSize" >= 1);
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_units_match_packs"
  CHECK ("unitsReceived" = "quantityReceived" * "packSize");
-- Nothing received means no ledger movement; anything received must name one.
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_movement_presence"
  CHECK (
    ("unitsReceived" = 0 AND "inventoryMovementId" IS NULL)
    OR ("unitsReceived" > 0 AND "inventoryMovementId" IS NOT NULL)
  );
