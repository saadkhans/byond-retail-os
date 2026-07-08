-- Phase 3: product catalog & inventory foundation.

-- New audit action for stock adjustments.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "AuditAction" ADD VALUE 'STOCK_ADJUSTMENT';

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISCONTINUED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('EACH', 'PACK', 'BOX', 'CASE', 'PAIR', 'GRAM', 'MILLILITER');

-- CreateEnum
CREATE TYPE "BarcodeFormat" AS ENUM ('EAN13', 'EAN8', 'UPC_A', 'UPC_E', 'CODE128', 'CODE39', 'QR', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('ADJUSTMENT');

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "categoryId" TEXT,
    "brandId" TEXT,
    "unitOfMeasure" "UnitOfMeasure" NOT NULL DEFAULT 'EACH',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "lowStockThreshold" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBarcode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "format" "BarcodeFormat" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLevel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "movementType" "InventoryMovementType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "quantityAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_tenantId_name_key" ON "ProductCategory"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_id_tenantId_key" ON "ProductCategory"("id", "tenantId");

-- CreateIndex
CREATE INDEX "ProductCategory_tenantId_parentId_idx" ON "ProductCategory"("tenantId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_tenantId_name_key" ON "Brand"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_id_tenantId_key" ON "Brand"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_tenantId_key" ON "Product"("id", "tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_status_idx" ON "Product"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Product_tenantId_categoryId_idx" ON "Product"("tenantId", "categoryId");

-- CreateIndex
CREATE INDEX "Product_tenantId_brandId_idx" ON "Product"("tenantId", "brandId");

-- CreateIndex
CREATE INDEX "Product_tenantId_name_idx" ON "Product"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBarcode_tenantId_value_key" ON "ProductBarcode"("tenantId", "value");

-- CreateIndex
CREATE INDEX "ProductBarcode_productId_idx" ON "ProductBarcode"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLevel_tenantId_locationId_productId_key" ON "InventoryLevel"("tenantId", "locationId", "productId");

-- CreateIndex
CREATE INDEX "InventoryLevel_tenantId_productId_idx" ON "InventoryLevel"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "InventoryLevel_tenantId_locationId_idx" ON "InventoryLevel"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryMovement_tenantId_locationId_productId_createdAt_idx" ON "InventoryMovement"("tenantId", "locationId", "productId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "InventoryMovement_tenantId_createdAt_idx" ON "InventoryMovement"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "InventoryMovement_productId_idx" ON "InventoryMovement"("productId");

-- CreateIndex
CREATE INDEX "InventoryMovement_locationId_idx" ON "InventoryMovement"("locationId");

-- CreateIndex
CREATE INDEX "InventoryMovement_createdById_idx" ON "InventoryMovement"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Location_id_tenantId_key" ON "Location"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- InventoryMovement rows are immutable (append-only triggers below): no FK
-- action may ever need to mutate them — Restrict deletes, NO ACTION updates
-- (same rationale as AuditLog).
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- 1. Stock can never go negative, even under concurrent adjustments: the
--    application guards with a conditional atomic increment, and this CHECK
--    backstops any future code path that forgets to.
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_quantity_nonnegative_check"
  CHECK ("quantity" >= 0);

-- 2. Ledger integrity: a movement always changes stock (delta never zero)
--    and can never record an impossible negative resulting quantity.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_quantityDelta_nonzero_check"
  CHECK ("quantityDelta" <> 0);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_quantityAfter_nonnegative_check"
  CHECK ("quantityAfter" >= 0);

-- 3. Cross-tenant reference integrity at the database level. The repository
--    layer already scopes every lookup by tenantId; these composite FKs make
--    it impossible for a catalog/inventory row to reference another tenant's
--    location, product, category, brand, or parent category even if an
--    unscoped id ever slipped through application code. (MATCH SIMPLE skips
--    the check when the nullable column is NULL — exactly what we want for
--    optional references.)
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parent_same_tenant_fkey"
  FOREIGN KEY ("parentId", "tenantId") REFERENCES "ProductCategory"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_same_tenant_fkey"
  FOREIGN KEY ("categoryId", "tenantId") REFERENCES "ProductCategory"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_brand_same_tenant_fkey"
  FOREIGN KEY ("brandId", "tenantId") REFERENCES "Brand"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 4. The inventory ledger is append-only at the database level, exactly like
--    AuditLog: stock history can never be rewritten, only appended to. The
--    projected level (InventoryLevel) is the ONLY mutable inventory table,
--    and it changes solely via atomic increments in the same transaction
--    that appends the ledger row.
CREATE FUNCTION prevent_inventory_movement_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'InventoryMovement is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movement_append_only
  BEFORE UPDATE OR DELETE ON "InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_movement_mutation();

CREATE TRIGGER inventory_movement_no_truncate
  BEFORE TRUNCATE ON "InventoryMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_inventory_movement_mutation();
