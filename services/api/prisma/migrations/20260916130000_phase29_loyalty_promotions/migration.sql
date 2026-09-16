-- Phase 29 — Loyalty and promotions.
--
-- THE CENTRAL INVARIANT: a promotion must not bypass price versioning. There
-- is deliberately NOTHING in this migration that touches "PriceBook",
-- "PriceBookVersion" or "PriceBookEntry" — no column, no trigger, no view.
-- A promotion composes ON TOP of the price version already in force, and the
-- provenance columns added to the basket/order lines below record BOTH halves
-- so any price a shopper paid names exactly one price version and at most one
-- promotion version.
--
-- Points are append-only at the database level (trigger, as for
-- InventoryMovement and AuditLog), so a loyalty balance is always a derived
-- SUM and never a mutable counter.

-- New audit actions for the two Phase 29 transitions with no generic
-- equivalent: a promotion version becoming effective, and an append to a
-- points ledger.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "AuditAction" ADD VALUE 'PROMOTION_CHANGE';
ALTER TYPE "AuditAction" ADD VALUE 'POINTS_MOVEMENT';

-- CreateEnum
CREATE TYPE "LoyaltyAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LoyaltyPointMovementType" AS ENUM ('ACCRUAL', 'REDEMPTION', 'ADJUSTMENT', 'EXPIRY', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PromotionVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PromotionAudience" AS ENUM ('ALL_SHOPPERS', 'LOYALTY_MEMBERS');

-- CreateEnum
CREATE TYPE "PromotionRuleKind" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_UNIT_PRICE');

-- CreateEnum
CREATE TYPE "PromotionChangeReason" AS ENUM ('INITIAL', 'RULE_CHANGE', 'CORRECTION', 'ROLLBACK');

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberCode" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "LoyaltyAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    -- Forward link to the Phase 26 Shopper, which does not exist yet on this
    -- line of development. Intentionally a bare nullable column with NO
    -- foreign key: when Shopper ships, one ALTER TABLE adds the composite
    -- same-tenant FK and nothing here has to be rewritten or backfilled.
    "shopperId" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyPointMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "type" "LoyaltyPointMovementType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "orderId" TEXT,
    "promotionVersionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyPointMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "audience" "PromotionAudience" NOT NULL DEFAULT 'ALL_SHOPPERS',
    "locationId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "PromotionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "reason" "PromotionChangeReason" NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "supersededByVersionId" TEXT,
    "rolledBackFromVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "productId" TEXT,
    "kind" "PromotionRuleKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "maxDiscountMinor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRule_pkey" PRIMARY KEY ("id")
);

-- AlterTable: the loyalty account a basket is shopped under. NULL = no
-- member, which is the pre-Phase-29 behaviour for every existing session.
ALTER TABLE "CheckoutSession" ADD COLUMN "loyaltyAccountId" TEXT;

-- AlterTable: price/promotion provenance on the basket line. All nullable, so
-- every row written before this release keeps its exact meaning.
ALTER TABLE "CheckoutSessionLine" ADD COLUMN "priceBookVersionId" TEXT;
ALTER TABLE "CheckoutSessionLine" ADD COLUMN "basePriceMinor" INTEGER;
ALTER TABLE "CheckoutSessionLine" ADD COLUMN "promotionVersionId" TEXT;
ALTER TABLE "CheckoutSessionLine" ADD COLUMN "promotionDiscountMinor" INTEGER;

-- AlterTable: the same provenance, copied onto the order line at completion.
ALTER TABLE "OrderLine" ADD COLUMN "priceBookVersionId" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "basePriceMinor" INTEGER;
ALTER TABLE "OrderLine" ADD COLUMN "promotionVersionId" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "promotionDiscountMinor" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_id_tenantId_key" ON "LoyaltyAccount"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_tenantId_memberCode_key" ON "LoyaltyAccount"("tenantId", "memberCode");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_tenantId_status_idx" ON "LoyaltyAccount"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_tenantId_shopperId_idx" ON "LoyaltyAccount"("tenantId", "shopperId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyPointMovement_id_tenantId_key" ON "LoyaltyPointMovement"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyPointMovement_tenantId_idempotencyKey_key" ON "LoyaltyPointMovement"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyPointMovement_accountId_sequenceNumber_key" ON "LoyaltyPointMovement"("accountId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "LoyaltyPointMovement_tenantId_accountId_createdAt_idx" ON "LoyaltyPointMovement"("tenantId", "accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyPointMovement_tenantId_orderId_idx" ON "LoyaltyPointMovement"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_id_tenantId_key" ON "Promotion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_tenantId_code_key" ON "Promotion"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Promotion_tenantId_status_idx" ON "Promotion"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Promotion_tenantId_locationId_status_idx" ON "Promotion"("tenantId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVersion_supersededByVersionId_key" ON "PromotionVersion"("supersededByVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVersion_id_tenantId_key" ON "PromotionVersion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVersion_promotionId_versionNumber_key" ON "PromotionVersion"("promotionId", "versionNumber");

-- CreateIndex
CREATE INDEX "PromotionVersion_tenantId_promotionId_status_idx" ON "PromotionVersion"("tenantId", "promotionId", "status");

-- CreateIndex
CREATE INDEX "PromotionVersion_tenantId_promotionId_effectiveFrom_idx" ON "PromotionVersion"("tenantId", "promotionId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PromotionVersion_tenantId_status_effectiveFrom_idx" ON "PromotionVersion"("tenantId", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionRule_id_tenantId_key" ON "PromotionRule"("id", "tenantId");

-- CreateIndex
CREATE INDEX "PromotionRule_tenantId_versionId_idx" ON "PromotionRule"("tenantId", "versionId");

-- CreateIndex
CREATE INDEX "PromotionRule_tenantId_productId_idx" ON "PromotionRule"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "CheckoutSession_tenantId_loyaltyAccountId_idx" ON "CheckoutSession"("tenantId", "loyaltyAccountId");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_tenantId_promotionVersionId_idx" ON "CheckoutSessionLine"("tenantId", "promotionVersionId");

-- CreateIndex
CREATE INDEX "OrderLine_tenantId_promotionVersionId_idx" ON "OrderLine"("tenantId", "promotionVersionId");

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_promotionVersionId_fkey" FOREIGN KEY ("promotionVersionId") REFERENCES "PromotionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_supersededByVersionId_fkey" FOREIGN KEY ("supersededByVersionId") REFERENCES "PromotionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_rolledBackFromVersionId_fkey" FOREIGN KEY ("rolledBackFromVersionId") REFERENCES "PromotionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PromotionVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_loyaltyAccountId_fkey" FOREIGN KEY ("loyaltyAccountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_priceBookVersionId_fkey" FOREIGN KEY ("priceBookVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_promotionVersionId_fkey" FOREIGN KEY ("promotionVersionId") REFERENCES "PromotionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_priceBookVersionId_fkey" FOREIGN KEY ("priceBookVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_promotionVersionId_fkey" FOREIGN KEY ("promotionVersionId") REFERENCES "PromotionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express in schema.prisma. These are the LAST line
-- of defence behind the DTOs and the service.
-- ---------------------------------------------------------------------------

-- 1. The points ledger is APPEND-ONLY at the database level, exactly like
--    InventoryMovement and AuditLog. This is what makes "points are a balance
--    derived from movements, never a mutable counter" structural rather than
--    a convention: there is no statement anybody can run — application code,
--    a migration, or a console — that edits or removes a points movement.
CREATE FUNCTION prevent_loyalty_point_movement_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LoyaltyPointMovement is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_point_movement_append_only
  BEFORE UPDATE OR DELETE ON "LoyaltyPointMovement"
  FOR EACH ROW EXECUTE FUNCTION prevent_loyalty_point_movement_mutation();

CREATE TRIGGER loyalty_point_movement_no_truncate
  BEFORE TRUNCATE ON "LoyaltyPointMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_loyalty_point_movement_mutation();

-- 2. THE BALANCE FLOOR. A redemption can never overdraw, because the floor is
--    a CHECK on the row being INSERTED rather than a decision the application
--    is trusted to have taken correctly. Combined with the unique
--    (accountId, sequenceNumber) index above — which makes two concurrent
--    redemptions that read the same tail collide instead of both committing —
--    a negative balance is unreachable even under a lost update.
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_balanceAfter_nonnegative"
  CHECK ("balanceAfter" >= 0);
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_points_nonzero"
  CHECK ("points" <> 0);
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_sequenceNumber_positive"
  CHECK ("sequenceNumber" >= 1);

-- 3. At most ONE ACTIVE version per promotion — the invariant that makes "the
--    discount currently in force" well defined, mirroring
--    PriceBookVersion_active_book_key. Partial unique indexes cannot be
--    expressed in schema.prisma.
CREATE UNIQUE INDEX "PromotionVersion_active_promotion_key"
  ON "PromotionVersion"("promotionId")
  WHERE "status" = 'ACTIVE';

-- 4. One rule per product per version, and at most ONE catalog-wide rule per
--    version. Two partial indexes because NULLs are distinct in a plain
--    unique index, so the catalog-wide rule needs its own.
CREATE UNIQUE INDEX "PromotionRule_version_product_key"
  ON "PromotionRule"("versionId", "productId")
  WHERE "productId" IS NOT NULL;
CREATE UNIQUE INDEX "PromotionRule_version_catalog_wide_key"
  ON "PromotionRule"("versionId")
  WHERE "productId" IS NULL;

-- 5. At most one loyalty account per shopper per tenant. Reserved NOW so that
--    wiring the Phase 26 Shopper later is a foreign key and nothing else.
CREATE UNIQUE INDEX "LoyaltyAccount_tenantId_shopperId_key"
  ON "LoyaltyAccount"("tenantId", "shopperId")
  WHERE "shopperId" IS NOT NULL;

-- 6. Promotion windows never run backwards, rule values are positive, version
--    numbers start at 1, and a version can neither supersede nor be a
--    rollback of itself — the same set Phase 25 put on price versions.
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_effective_window_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_versionNumber_positive"
  CHECK ("versionNumber" >= 1);
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_no_self_supersession"
  CHECK ("supersededByVersionId" IS NULL OR "supersededByVersionId" <> "id");
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_no_self_rollback"
  CHECK ("rolledBackFromVersionId" IS NULL OR "rolledBackFromVersionId" <> "id");
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_value_positive"
  CHECK ("value" > 0);
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_percent_off_basis_points"
  CHECK ("kind" <> 'PERCENT_OFF' OR "value" <= 10000);
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_maxDiscountMinor_positive"
  CHECK ("maxDiscountMinor" IS NULL OR "maxDiscountMinor" > 0);

-- 7. A PROMOTION CAN ONLY EVER SUBTRACT. These CHECKs live on the basket and
--    order lines, which is exactly where a bug in promotion composition would
--    surface: the discount is never negative, never exceeds the base price,
--    and the final unit price is always base minus discount. A promotion that
--    tried to RAISE a price — the closest thing to "bypassing price
--    versioning" that composition could produce — is a failed write.
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_promotion_subtractive"
  CHECK (
    "promotionDiscountMinor" IS NULL
    OR (
      "basePriceMinor" IS NOT NULL
      AND "unitPriceMinor" IS NOT NULL
      AND "promotionDiscountMinor" >= 0
      AND "promotionDiscountMinor" <= "basePriceMinor"
      AND "unitPriceMinor" = "basePriceMinor" - "promotionDiscountMinor"
    )
  );
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_promotion_subtractive"
  CHECK (
    "promotionDiscountMinor" IS NULL
    OR (
      "basePriceMinor" IS NOT NULL
      AND "unitPriceMinor" IS NOT NULL
      AND "promotionDiscountMinor" >= 0
      AND "promotionDiscountMinor" <= "basePriceMinor"
      AND "unitPriceMinor" = "basePriceMinor" - "promotionDiscountMinor"
    )
  );

-- 8. A promotion is never recorded on a line without the price version it was
--    computed from. This is the structural statement of "explainable": you
--    can always name the price version AND the promotion version behind a
--    number a shopper paid.
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_promotion_needs_price_version"
  CHECK ("promotionVersionId" IS NULL OR "priceBookVersionId" IS NOT NULL);
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_promotion_needs_price_version"
  CHECK ("promotionVersionId" IS NULL OR "priceBookVersionId" IS NOT NULL);

-- 9. Same-tenant composite foreign keys. The single-column FKs above only
--    prove the referenced row EXISTS; these prove it belongs to the SAME
--    tenant, so a cross-tenant id can never be stitched into a loyalty
--    account, a promotion, or a promoted basket line even if application code
--    slipped. (A composite FK with a NULL column is satisfied automatically,
--    which is what we want for optional references.)
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_account_same_tenant_fkey"
  FOREIGN KEY ("accountId", "tenantId") REFERENCES "LoyaltyAccount"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_order_same_tenant_fkey"
  FOREIGN KEY ("orderId", "tenantId") REFERENCES "Order"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoyaltyPointMovement" ADD CONSTRAINT "LoyaltyPointMovement_promotionVersion_same_tenant_fkey"
  FOREIGN KEY ("promotionVersionId", "tenantId") REFERENCES "PromotionVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdBy_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_promotion_same_tenant_fkey"
  FOREIGN KEY ("promotionId", "tenantId") REFERENCES "Promotion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_superseded_same_tenant_fkey"
  FOREIGN KEY ("supersededByVersionId", "tenantId") REFERENCES "PromotionVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_rollback_same_tenant_fkey"
  FOREIGN KEY ("rolledBackFromVersionId", "tenantId") REFERENCES "PromotionVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_version_same_tenant_fkey"
  FOREIGN KEY ("versionId", "tenantId") REFERENCES "PromotionVersion"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_loyaltyAccount_same_tenant_fkey"
  FOREIGN KEY ("loyaltyAccountId", "tenantId") REFERENCES "LoyaltyAccount"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_priceVersion_same_tenant_fkey"
  FOREIGN KEY ("priceBookVersionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_promotionVersion_same_tenant_fkey"
  FOREIGN KEY ("promotionVersionId", "tenantId") REFERENCES "PromotionVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_priceVersion_same_tenant_fkey"
  FOREIGN KEY ("priceBookVersionId", "tenantId") REFERENCES "PriceBookVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_promotionVersion_same_tenant_fkey"
  FOREIGN KEY ("promotionVersionId", "tenantId") REFERENCES "PromotionVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
