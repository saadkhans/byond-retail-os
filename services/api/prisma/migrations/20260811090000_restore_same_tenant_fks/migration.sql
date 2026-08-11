-- Restore the same-tenant composite foreign keys dropped by
-- 20260802115214_m1. That migration was an auto-generated drift diff:
-- the composite FKs are hand-written (they do not appear in
-- schema.prisma), so `prisma migrate dev` saw them as extraneous and
-- emitted DROPs. They are the database-level tenant-isolation guarantee
-- (AGENTS.md: tenancy). Every statement below recreates a dropped
-- constraint EXACTLY as its originating migration defined it, with
-- DROP IF EXISTS first so the migration is safe both on databases that
-- ran m1 (constraint gone) and on any that never lost it.
--
-- DELIBERATE EXCEPTIONS (3 of 63) - constraints referencing
-- User(id, tenantId) are NOT restored:
--   InferenceJob_creator_same_tenant_fkey
--   VideoAsset_uploader_same_tenant_fkey
--   VideoArtifact_creator_same_tenant_fkey
-- Platform administrators (User.tenantId IS NULL) operate inside the
-- seeded platform-sandbox tenant (src/tenants/platform-sandbox.ts), so
-- rows they create carry (createdById/uploadedById = platform user,
-- tenantId = sandbox) - a pair that can never exist in User(id,
-- tenantId). A composite FK cannot express "same tenant OR platform
-- user"; those references remain enforced by the plain per-column FK
-- to User(id) plus repository-layer tenant scoping.

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "CheckoutSession" DROP CONSTRAINT IF EXISTS "CheckoutSession_device_same_tenant_fkey";
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_device_same_tenant_fkey" FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "CheckoutSession" DROP CONSTRAINT IF EXISTS "CheckoutSession_evidenceBundle_same_tenant_fkey";
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_evidenceBundle_same_tenant_fkey" FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "CheckoutSession" DROP CONSTRAINT IF EXISTS "CheckoutSession_location_same_tenant_fkey";
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "CheckoutSession" DROP CONSTRAINT IF EXISTS "CheckoutSession_unit_same_tenant_fkey";
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "CheckoutSession" DROP CONSTRAINT IF EXISTS "CheckoutSession_visionEvent_same_tenant_fkey";
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_visionEvent_same_tenant_fkey" FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT IF EXISTS "CheckoutSessionLine_evidenceBundle_same_tenant_fkey";
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_evidenceBundle_same_tenant_fkey" FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT IF EXISTS "CheckoutSessionLine_product_same_tenant_fkey";
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT IF EXISTS "CheckoutSessionLine_session_same_tenant_fkey";
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_session_same_tenant_fkey" FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT IF EXISTS "CheckoutSessionLine_visionEvent_same_tenant_fkey";
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_visionEvent_same_tenant_fkey" FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260711000000_store_unit_device\migration.sql
ALTER TABLE "Device" DROP CONSTRAINT IF EXISTS "Device_unit_same_tenant_fkey";
ALTER TABLE "Device" ADD CONSTRAINT "Device_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceCandidate" DROP CONSTRAINT IF EXISTS "InferenceCandidate_result_same_tenant_fkey";
ALTER TABLE "InferenceCandidate" ADD CONSTRAINT "InferenceCandidate_result_same_tenant_fkey" FOREIGN KEY ("resultId", "tenantId") REFERENCES "InferenceResult"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceJob" DROP CONSTRAINT IF EXISTS "InferenceJob_device_same_tenant_fkey";
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_device_same_tenant_fkey" FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceJob" DROP CONSTRAINT IF EXISTS "InferenceJob_location_same_tenant_fkey";
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceJob" DROP CONSTRAINT IF EXISTS "InferenceJob_session_same_tenant_fkey";
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_session_same_tenant_fkey" FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceJob" DROP CONSTRAINT IF EXISTS "InferenceJob_unit_same_tenant_fkey";
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceJob" DROP CONSTRAINT IF EXISTS "InferenceJob_visionEvent_same_tenant_fkey";
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_visionEvent_same_tenant_fkey" FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260726000000_inference\migration.sql
ALTER TABLE "InferenceResult" DROP CONSTRAINT IF EXISTS "InferenceResult_job_same_tenant_fkey";
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_job_same_tenant_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "InferenceJob"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "InventoryLevel" DROP CONSTRAINT IF EXISTS "InventoryLevel_location_same_tenant_fkey";
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "InventoryLevel" DROP CONSTRAINT IF EXISTS "InventoryLevel_product_same_tenant_fkey";
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "InventoryMovement" DROP CONSTRAINT IF EXISTS "InventoryMovement_location_same_tenant_fkey";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "InventoryMovement" DROP CONSTRAINT IF EXISTS "InventoryMovement_product_same_tenant_fkey";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_evidenceBundle_same_tenant_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_evidenceBundle_same_tenant_fkey" FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_location_same_tenant_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_session_same_tenant_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_session_same_tenant_fkey" FOREIGN KEY ("checkoutSessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_unit_same_tenant_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_visionEvent_same_tenant_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_visionEvent_same_tenant_fkey" FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "OrderLine" DROP CONSTRAINT IF EXISTS "OrderLine_evidenceBundle_same_tenant_fkey";
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_evidenceBundle_same_tenant_fkey" FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "OrderLine" DROP CONSTRAINT IF EXISTS "OrderLine_order_same_tenant_fkey";
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_order_same_tenant_fkey" FOREIGN KEY ("orderId", "tenantId") REFERENCES "Order"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "OrderLine" DROP CONSTRAINT IF EXISTS "OrderLine_product_same_tenant_fkey";
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260713000000_checkout_session_orders\migration.sql
ALTER TABLE "OrderLine" DROP CONSTRAINT IF EXISTS "OrderLine_sessionLine_same_tenant_fkey";
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_sessionLine_same_tenant_fkey" FOREIGN KEY ("sessionLineId", "tenantId") REFERENCES "CheckoutSessionLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260720000000_legacy_vision_ref_compat\migration.sql
ALTER TABLE "OrderLine" DROP CONSTRAINT IF EXISTS "OrderLine_visionEvent_same_tenant_fkey";
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_visionEvent_same_tenant_fkey" FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentAuthorization" DROP CONSTRAINT IF EXISTS "PaymentAuthorization_intent_same_tenant_fkey";
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_intent_same_tenant_fkey" FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentCapture" DROP CONSTRAINT IF EXISTS "PaymentCapture_intent_same_tenant_fkey";
ALTER TABLE "PaymentCapture" ADD CONSTRAINT "PaymentCapture_intent_same_tenant_fkey" FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentEvent" DROP CONSTRAINT IF EXISTS "PaymentEvent_intent_same_tenant_fkey";
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_intent_same_tenant_fkey" FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "PaymentIntent_order_same_tenant_fkey";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_order_same_tenant_fkey" FOREIGN KEY ("orderId", "tenantId") REFERENCES "Order"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentIntent" DROP CONSTRAINT IF EXISTS "PaymentIntent_session_same_tenant_fkey";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_session_same_tenant_fkey" FOREIGN KEY ("checkoutSessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentReconciliationRecord" DROP CONSTRAINT IF EXISTS "PaymentReconciliationRecord_capture_same_tenant_fkey";
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_capture_same_tenant_fkey" FOREIGN KEY ("captureId", "tenantId") REFERENCES "PaymentCapture"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260716000000_payments_reconciliation\migration.sql
ALTER TABLE "PaymentReconciliationRecord" DROP CONSTRAINT IF EXISTS "PaymentReconciliationRecord_intent_same_tenant_fkey";
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_intent_same_tenant_fkey" FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_brand_same_tenant_fkey";
ALTER TABLE "Product" ADD CONSTRAINT "Product_brand_same_tenant_fkey" FOREIGN KEY ("brandId", "tenantId") REFERENCES "Brand"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_category_same_tenant_fkey";
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_same_tenant_fkey" FOREIGN KEY ("categoryId", "tenantId") REFERENCES "ProductCategory"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "ProductBarcode" DROP CONSTRAINT IF EXISTS "ProductBarcode_product_same_tenant_fkey";
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260708000000_catalog_inventory\migration.sql
ALTER TABLE "ProductCategory" DROP CONSTRAINT IF EXISTS "ProductCategory_parent_same_tenant_fkey";
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parent_same_tenant_fkey" FOREIGN KEY ("parentId", "tenantId") REFERENCES "ProductCategory"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260711000000_store_unit_device\migration.sql
ALTER TABLE "RetailUnit" DROP CONSTRAINT IF EXISTS "RetailUnit_location_same_tenant_fkey";
ALTER TABLE "RetailUnit" ADD CONSTRAINT "RetailUnit_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000000_video_ingest\migration.sql
ALTER TABLE "VideoArtifact" DROP CONSTRAINT IF EXISTS "VideoArtifact_asset_same_tenant_fkey";
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_asset_same_tenant_fkey" FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000000_video_ingest\migration.sql
ALTER TABLE "VideoArtifact" DROP CONSTRAINT IF EXISTS "VideoArtifact_job_same_tenant_fkey";
ALTER TABLE "VideoArtifact" ADD CONSTRAINT "VideoArtifact_job_same_tenant_fkey" FOREIGN KEY ("inferenceJobId", "tenantId") REFERENCES "InferenceJob"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000000_video_ingest\migration.sql
ALTER TABLE "VideoAsset" DROP CONSTRAINT IF EXISTS "VideoAsset_device_same_tenant_fkey";
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_device_same_tenant_fkey" FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000000_video_ingest\migration.sql
ALTER TABLE "VideoAsset" DROP CONSTRAINT IF EXISTS "VideoAsset_location_same_tenant_fkey";
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000000_video_ingest\migration.sql
ALTER TABLE "VideoAsset" DROP CONSTRAINT IF EXISTS "VideoAsset_session_same_tenant_fkey";
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_session_same_tenant_fkey" FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000000_video_ingest\migration.sql
ALTER TABLE "VideoAsset" DROP CONSTRAINT IF EXISTS "VideoAsset_unit_same_tenant_fkey";
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260727000002_video_extraction_request\migration.sql
ALTER TABLE "VideoExtractionRequest" DROP CONSTRAINT IF EXISTS "VideoExtractionRequest_asset_same_tenant_fkey";
ALTER TABLE "VideoExtractionRequest" ADD CONSTRAINT "VideoExtractionRequest_asset_same_tenant_fkey" FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEvent" DROP CONSTRAINT IF EXISTS "VisionEvent_bundle_same_tenant_fkey";
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_bundle_same_tenant_fkey" FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEvent" DROP CONSTRAINT IF EXISTS "VisionEvent_device_same_tenant_fkey";
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_device_same_tenant_fkey" FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEvent" DROP CONSTRAINT IF EXISTS "VisionEvent_location_same_tenant_fkey";
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_location_same_tenant_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEvent" DROP CONSTRAINT IF EXISTS "VisionEvent_session_same_tenant_fkey";
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_session_same_tenant_fkey" FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEvent" DROP CONSTRAINT IF EXISTS "VisionEvent_unit_same_tenant_fkey";
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_unit_same_tenant_fkey" FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEventCandidate" DROP CONSTRAINT IF EXISTS "VisionEventCandidate_event_same_tenant_fkey";
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_event_same_tenant_fkey" FOREIGN KEY ("eventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEventCandidate" DROP CONSTRAINT IF EXISTS "VisionEventCandidate_product_same_tenant_fkey";
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_product_same_tenant_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEventReview" DROP CONSTRAINT IF EXISTS "VisionEventReview_event_same_tenant_fkey";
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_event_same_tenant_fkey" FOREIGN KEY ("eventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEventReview" DROP CONSTRAINT IF EXISTS "VisionEventReview_product_same_tenant_fkey";
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_product_same_tenant_fkey" FOREIGN KEY ("appliedProductId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- from 20260719000000_vision_events\migration.sql
ALTER TABLE "VisionEventReview" DROP CONSTRAINT IF EXISTS "VisionEventReview_sessionLine_same_tenant_fkey";
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_sessionLine_same_tenant_fkey" FOREIGN KEY ("sessionLineId", "tenantId") REFERENCES "CheckoutSessionLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
