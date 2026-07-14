-- Phase 5 hardening: basket line removal becomes a SOFT delete.
--
-- Removing a line used to hard-delete the row — and with it the only durable
-- record of the line's add idempotencyKey. A client whose add-line response
-- was lost could then retry the same key AFTER the line was intentionally
-- removed and silently resurrect the item (later consuming stock for it at
-- completion). REMOVED rows now survive as tombstones: the tenant-scoped
-- (tenantId, idempotencyKey) unique keeps the key reserved forever, and the
-- application excludes REMOVED lines from the active basket and completion.

-- CreateEnum
CREATE TYPE "CheckoutSessionLineStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- AlterTable
ALTER TABLE "CheckoutSessionLine" ADD COLUMN "status" "CheckoutSessionLineStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "CheckoutSessionLine" ADD COLUMN "removedAt" TIMESTAMP(3);

-- "One line per product per session" must exempt tombstones, or a product
-- could never be legitimately re-added after a removal. Replace the full
-- unique with a PARTIAL unique index over ACTIVE lines only (hand-written —
-- Prisma cannot express partial indexes; do not drop when regenerating
-- migrations).
DROP INDEX "CheckoutSessionLine_tenantId_sessionId_productId_key";
CREATE UNIQUE INDEX "CheckoutSessionLine_active_product_key"
  ON "CheckoutSessionLine"("tenantId", "sessionId", "productId")
  WHERE "status" = 'ACTIVE';

-- CreateIndex (plain lookup index over all lines, tombstones included).
CREATE INDEX "CheckoutSessionLine_tenantId_sessionId_productId_idx"
  ON "CheckoutSessionLine"("tenantId", "sessionId", "productId");

-- BYOND hardening: a tombstone always knows when it was removed, and an
-- active line never carries a removal timestamp.
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_removed_has_timestamp_check"
  CHECK (("status" = 'REMOVED') = ("removedAt" IS NOT NULL));
