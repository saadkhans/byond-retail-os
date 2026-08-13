-- Same-tenant composite foreign keys for the six CV tables introduced by
-- 20260803144010_pickup_validation, 20260805085011_pickup_fusion_v2, and
-- 20260809085652_customer_journey_skeleton. Those migrations shipped with
-- single-column FKs only, so the database would accept tenant A's journey
-- event pointing at tenant B's product. Composite FKs are the
-- database-level tenant-isolation guarantee (AGENTS.md: tenancy) —
-- repository-layer scoping alone is not enough — mirroring
-- 20260811090000_restore_same_tenant_fks.
--
-- Referencing pairs always include the child's NOT NULL "tenantId", so
-- nullable columns (unitId, productId) still short-circuit to "no
-- reference" under MATCH SIMPLE exactly like their single-column FKs.
-- ON DELETE/ON UPDATE actions mirror each sibling single-column FK: a
-- composite RESTRICT beside a single-column CASCADE would silently veto
-- the cascade the schema promises.
--
-- The createdById columns are deliberately NOT covered: they reference
-- User, and platform administrators (User.tenantId IS NULL) act inside
-- the seeded platform-sandbox tenant, a pair that can never exist in
-- User(id, tenantId) — same exception as the restore migration.

-- Composite anchors for the two NEW parent tables referenced below (also
-- added to schema.prisma as @@unique([id, tenantId]) so a drift diff
-- keeps them). Every other parent (Location, RetailUnit, Product,
-- VideoAsset) already carries its anchor.
CREATE UNIQUE INDEX "CustomerJourney_id_tenantId_key" ON "CustomerJourney"("id", "tenantId");
CREATE UNIQUE INDEX "ProductReferenceImage_id_tenantId_key" ON "ProductReferenceImage"("id", "tenantId");

-- for 20260809085652_customer_journey_skeleton
ALTER TABLE "CustomerJourney" DROP CONSTRAINT IF EXISTS "CustomerJourney_location_same_tenant_fkey";
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- for 20260809085652_customer_journey_skeleton
ALTER TABLE "CustomerJourney" DROP CONSTRAINT IF EXISTS "CustomerJourney_unit_same_tenant_fkey";
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- for 20260809085652_customer_journey_skeleton (events cascade with their
-- journey, mirroring CustomerJourneyEvent_journeyId_fkey)
ALTER TABLE "CustomerJourneyEvent" DROP CONSTRAINT IF EXISTS "CustomerJourneyEvent_journey_same_tenant_fkey";
ALTER TABLE "CustomerJourneyEvent" ADD CONSTRAINT "CustomerJourneyEvent_journey_same_tenant_fkey" FOREIGN KEY ("journeyId", "tenantId") REFERENCES "CustomerJourney"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- for 20260809085652_customer_journey_skeleton
ALTER TABLE "CustomerJourneyEvent" DROP CONSTRAINT IF EXISTS "CustomerJourneyEvent_product_same_tenant_fkey";
ALTER TABLE "CustomerJourneyEvent" ADD CONSTRAINT "CustomerJourneyEvent_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- for 20260803144010_pickup_validation
ALTER TABLE "ProductReferenceImage" DROP CONSTRAINT IF EXISTS "ProductReferenceImage_product_same_tenant_fkey";
ALTER TABLE "ProductReferenceImage" ADD CONSTRAINT "ProductReferenceImage_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- for 20260803144010_pickup_validation (ground truth cascades with its
-- asset, mirroring VideoGroundTruth_videoAssetId_fkey)
ALTER TABLE "VideoGroundTruth" DROP CONSTRAINT IF EXISTS "VideoGroundTruth_videoAsset_same_tenant_fkey";
ALTER TABLE "VideoGroundTruth" ADD CONSTRAINT "VideoGroundTruth_videoAsset_same_tenant_fkey" FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- for 20260803144010_pickup_validation
ALTER TABLE "VideoGroundTruth" DROP CONSTRAINT IF EXISTS "VideoGroundTruth_product_same_tenant_fkey";
ALTER TABLE "VideoGroundTruth" ADD CONSTRAINT "VideoGroundTruth_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- for 20260805085011_pickup_fusion_v2
ALTER TABLE "ProductReferenceEmbedding" DROP CONSTRAINT IF EXISTS "ProductReferenceEmbedding_product_same_tenant_fkey";
ALTER TABLE "ProductReferenceEmbedding" ADD CONSTRAINT "ProductReferenceEmbedding_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- for 20260805085011_pickup_fusion_v2 (embeddings cascade with their
-- reference image, mirroring ProductReferenceEmbedding_referenceImageId_fkey)
ALTER TABLE "ProductReferenceEmbedding" DROP CONSTRAINT IF EXISTS "ProductReferenceEmbedding_referenceImage_same_tenant_fkey";
ALTER TABLE "ProductReferenceEmbedding" ADD CONSTRAINT "ProductReferenceEmbedding_referenceImage_same_tenant_fkey" FOREIGN KEY ("referenceImageId", "tenantId") REFERENCES "ProductReferenceImage"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- for 20260805085011_pickup_fusion_v2 (runs cascade with their asset,
-- mirroring PickupFusionRun_videoAssetId_fkey)
ALTER TABLE "PickupFusionRun" DROP CONSTRAINT IF EXISTS "PickupFusionRun_videoAsset_same_tenant_fkey";
ALTER TABLE "PickupFusionRun" ADD CONSTRAINT "PickupFusionRun_videoAsset_same_tenant_fkey" FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
