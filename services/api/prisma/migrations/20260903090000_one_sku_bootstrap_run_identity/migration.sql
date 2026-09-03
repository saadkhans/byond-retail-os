-- One-SKU bootstrap run identity (Codex P2): a STRUCTURED find-or-create
-- key for the per-SKU bootstrap evaluation run. Name-prefix matching
-- alone can neither be made race-safe (two concurrent first corrections
-- both see "no open run" and create duplicates) nor collision-safe
-- (SKU "ABC" prefixes "ABC-1"), so the bootstrap workflow now stamps the
-- bootstrapped product id directly on the run. NULL for every other
-- pilot evaluation run — nothing changes for them.
ALTER TABLE "PilotEvaluationRun" ADD COLUMN "bootstrapProductId" TEXT;

-- CreateIndex
CREATE INDEX "PilotEvaluationRun_tenantId_bootstrapProductId_idx" ON "PilotEvaluationRun"("tenantId", "bootstrapProductId");

-- At most ONE OPEN bootstrap run per tenant/product (partial unique —
-- Prisma cannot express the WHERE clause; same discipline as
-- CameraCalibrationProfile_one_active_per_source_key). Two concurrent
-- first corrections both try to create the family's first run; the loser
-- hits this index (P2002) and re-reads the winner's open run instead of
-- opening a duplicate that would split reviews. Terminal
-- (COMPLETED/CANCELLED) runs leave the slot free for a successor.
CREATE UNIQUE INDEX "PilotEvaluationRun_one_open_bootstrap_per_product_key" ON "PilotEvaluationRun"("tenantId", "bootstrapProductId") WHERE "status" = 'OPEN' AND "bootstrapProductId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "PilotEvaluationRun" ADD CONSTRAINT "PilotEvaluationRun_bootstrapProductId_fkey" FOREIGN KEY ("bootstrapProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
