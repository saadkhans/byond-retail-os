-- DropForeignKey
ALTER TABLE "CheckoutSession" DROP CONSTRAINT "CheckoutSession_device_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSession" DROP CONSTRAINT "CheckoutSession_evidenceBundle_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSession" DROP CONSTRAINT "CheckoutSession_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSession" DROP CONSTRAINT "CheckoutSession_unit_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSession" DROP CONSTRAINT "CheckoutSession_visionEvent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT "CheckoutSessionLine_evidenceBundle_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT "CheckoutSessionLine_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT "CheckoutSessionLine_session_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "CheckoutSessionLine" DROP CONSTRAINT "CheckoutSessionLine_visionEvent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_unit_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceCandidate" DROP CONSTRAINT "InferenceCandidate_result_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_creator_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_device_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_session_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_unit_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_visionEvent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InferenceResult" DROP CONSTRAINT "InferenceResult_job_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InventoryLevel" DROP CONSTRAINT "InventoryLevel_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InventoryLevel" DROP CONSTRAINT "InventoryLevel_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_evidenceBundle_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_session_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_unit_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_visionEvent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_evidenceBundle_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_order_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_sessionLine_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_visionEvent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentAuthorization" DROP CONSTRAINT "PaymentAuthorization_intent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentCapture" DROP CONSTRAINT "PaymentCapture_intent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentEvent" DROP CONSTRAINT "PaymentEvent_intent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_order_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_session_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentReconciliationRecord" DROP CONSTRAINT "PaymentReconciliationRecord_capture_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "PaymentReconciliationRecord" DROP CONSTRAINT "PaymentReconciliationRecord_intent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_brand_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_category_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "ProductBarcode" DROP CONSTRAINT "ProductBarcode_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "ProductCategory" DROP CONSTRAINT "ProductCategory_parent_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "RetailUnit" DROP CONSTRAINT "RetailUnit_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoArtifact" DROP CONSTRAINT "VideoArtifact_asset_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoArtifact" DROP CONSTRAINT "VideoArtifact_creator_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoArtifact" DROP CONSTRAINT "VideoArtifact_job_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoAsset" DROP CONSTRAINT "VideoAsset_device_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoAsset" DROP CONSTRAINT "VideoAsset_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoAsset" DROP CONSTRAINT "VideoAsset_session_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoAsset" DROP CONSTRAINT "VideoAsset_unit_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoAsset" DROP CONSTRAINT "VideoAsset_uploader_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VideoExtractionRequest" DROP CONSTRAINT "VideoExtractionRequest_asset_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEvent" DROP CONSTRAINT "VisionEvent_bundle_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEvent" DROP CONSTRAINT "VisionEvent_device_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEvent" DROP CONSTRAINT "VisionEvent_location_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEvent" DROP CONSTRAINT "VisionEvent_session_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEvent" DROP CONSTRAINT "VisionEvent_unit_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEventCandidate" DROP CONSTRAINT "VisionEventCandidate_event_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEventCandidate" DROP CONSTRAINT "VisionEventCandidate_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEventReview" DROP CONSTRAINT "VisionEventReview_event_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEventReview" DROP CONSTRAINT "VisionEventReview_product_same_tenant_fkey";

-- DropForeignKey
ALTER TABLE "VisionEventReview" DROP CONSTRAINT "VisionEventReview_sessionLine_same_tenant_fkey";
