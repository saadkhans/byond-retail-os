-- Phase 7 compatibility: legacy opaque checkout evidence references.
--
-- Before Phase 7, the Phase 5 checkout API accepted visionEventId /
-- evidenceBundleId as OPAQUE "future adapter" references and stored them
-- verbatim on checkout sessions, basket lines, orders, and order lines.
-- Phase 7 introduces the canonical VisionEvent / EvidenceBundle tables, and
-- from now on those columns are CANONICAL: they may only reference real
-- Phase 7 rows of the SAME tenant (validated at the data-access layer,
-- backstopped by the composite same-tenant FKs added below).
--
-- Pre-Phase-7 values would otherwise become dangling ids that checkout
-- completion keeps copying onto new orders as if they were canonical CV
-- lineage. Policy: legacy opaque refs are preserved — verbatim, auditable —
-- in the NEW external* columns, and the canonical columns are cleared
-- wherever the stored value does not resolve to a same-tenant Phase 7 row.
-- The external columns are compatibility storage only: the API never writes
-- them and never resolves them against Phase 7 tables.

-- 1. Compatibility columns.
ALTER TABLE "CheckoutSession"
  ADD COLUMN "externalVisionEventRef" TEXT,
  ADD COLUMN "externalEvidenceBundleRef" TEXT;
ALTER TABLE "CheckoutSessionLine"
  ADD COLUMN "externalVisionEventRef" TEXT,
  ADD COLUMN "externalEvidenceBundleRef" TEXT;
ALTER TABLE "Order"
  ADD COLUMN "externalVisionEventRef" TEXT,
  ADD COLUMN "externalEvidenceBundleRef" TEXT;
ALTER TABLE "OrderLine"
  ADD COLUMN "externalVisionEventRef" TEXT,
  ADD COLUMN "externalEvidenceBundleRef" TEXT;

-- 2. Move every stored reference that does NOT resolve to a same-tenant
--    Phase 7 row into the external columns and clear the canonical column.
--    (On upgrades from Phase 5 the Phase 7 tables were created empty by the
--    previous migration, so ALL pre-existing values move; the resolving
--    subquery keeps the migration correct even if it ever reruns later.)
UPDATE "CheckoutSession" s
SET "externalVisionEventRef" = s."visionEventId", "visionEventId" = NULL
WHERE s."visionEventId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "VisionEvent" v
    WHERE v."id" = s."visionEventId" AND v."tenantId" = s."tenantId"
  );
UPDATE "CheckoutSession" s
SET "externalEvidenceBundleRef" = s."evidenceBundleId", "evidenceBundleId" = NULL
WHERE s."evidenceBundleId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EvidenceBundle" b
    WHERE b."id" = s."evidenceBundleId" AND b."tenantId" = s."tenantId"
  );

UPDATE "CheckoutSessionLine" l
SET "externalVisionEventRef" = l."visionEventId", "visionEventId" = NULL
WHERE l."visionEventId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "VisionEvent" v
    WHERE v."id" = l."visionEventId" AND v."tenantId" = l."tenantId"
  );
UPDATE "CheckoutSessionLine" l
SET "externalEvidenceBundleRef" = l."evidenceBundleId", "evidenceBundleId" = NULL
WHERE l."evidenceBundleId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EvidenceBundle" b
    WHERE b."id" = l."evidenceBundleId" AND b."tenantId" = l."tenantId"
  );

UPDATE "Order" o
SET "externalVisionEventRef" = o."visionEventId", "visionEventId" = NULL
WHERE o."visionEventId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "VisionEvent" v
    WHERE v."id" = o."visionEventId" AND v."tenantId" = o."tenantId"
  );
UPDATE "Order" o
SET "externalEvidenceBundleRef" = o."evidenceBundleId", "evidenceBundleId" = NULL
WHERE o."evidenceBundleId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EvidenceBundle" b
    WHERE b."id" = o."evidenceBundleId" AND b."tenantId" = o."tenantId"
  );

UPDATE "OrderLine" ol
SET "externalVisionEventRef" = ol."visionEventId", "visionEventId" = NULL
WHERE ol."visionEventId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "VisionEvent" v
    WHERE v."id" = ol."visionEventId" AND v."tenantId" = ol."tenantId"
  );
UPDATE "OrderLine" ol
SET "externalEvidenceBundleRef" = ol."evidenceBundleId", "evidenceBundleId" = NULL
WHERE ol."evidenceBundleId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EvidenceBundle" b
    WHERE b."id" = ol."evidenceBundleId" AND b."tenantId" = ol."tenantId"
  );

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Do not drop when regenerating migrations.
------------------------------------------------------------------------------

-- 3. With legacy values relocated, the canonical columns can carry composite
--    same-tenant FKs (same pattern as Phases 3–7): a checkout/order row can
--    never again reference a nonexistent or cross-tenant vision event or
--    evidence bundle — dangling canonical CV lineage is now impossible at
--    the database level. (MATCH SIMPLE skips NULLs — optional references
--    stay optional.)
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_visionEvent_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_evidenceBundle_same_tenant_fkey"
  FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_visionEvent_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_evidenceBundle_same_tenant_fkey"
  FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Order" ADD CONSTRAINT "Order_visionEvent_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Order" ADD CONSTRAINT "Order_evidenceBundle_same_tenant_fkey"
  FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_visionEvent_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_evidenceBundle_same_tenant_fkey"
  FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
