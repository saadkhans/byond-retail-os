-- Phase 7: CV product recognition & virtual basket foundation.
--
-- Vendor-neutral by construction: sourceType/sourceId/modelName/modelVersion
-- are OPAQUE metadata; no camera/detector/(V)LM-specific columns exist.
-- EvidenceBundle stores artifact DESCRIPTORS only (never binary media).
-- Ingestion NEVER mutates the basket or inventory — only an approved review
-- decision does, atomically with the VisionEventReview row that records it.

-- New audit actions for review decisions.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "AuditAction" ADD VALUE 'APPROVE';
ALTER TYPE "AuditAction" ADD VALUE 'REJECT';
ALTER TYPE "AuditAction" ADD VALUE 'OVERRIDE';

-- CreateEnum
CREATE TYPE "VisionEventType" AS ENUM ('PRODUCT_PICKUP', 'PRODUCT_RETURN', 'PRODUCT_TRANSFER', 'CART_INSERTION', 'EXIT_RECONCILIATION');

-- CreateEnum
CREATE TYPE "VisionEventStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "VisionReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "VisionBasketEffect" AS ENUM ('LINE_ADDED', 'LINE_INCREASED', 'LINE_DECREASED', 'LINE_REMOVED', 'NONE');

-- CreateTable
CREATE TABLE "EvidenceBundle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'VISION',
    "sourceId" TEXT,
    "modelName" TEXT,
    "modelVersion" TEXT,
    "captureStartedAt" TIMESTAMP(3),
    "captureEndedAt" TIMESTAMP(3),
    "artifacts" JSONB,
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "deviceId" TEXT,
    "sessionId" TEXT,
    "type" "VisionEventType" NOT NULL,
    "status" "VisionEventStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'VISION',
    "sourceId" TEXT,
    "modelName" TEXT,
    "modelVersion" TEXT,
    "evidenceBundleId" TEXT,
    "evidenceScore" DOUBLE PRECISION,
    "evidenceQuality" "EvidenceQuality",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionEventCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION,
    "label" TEXT,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisionEventCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionEventReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "decision" "VisionReviewDecision" NOT NULL,
    "reason" TEXT,
    "appliedProductId" TEXT,
    "appliedQuantity" INTEGER,
    "basketEffect" "VisionBasketEffect" NOT NULL DEFAULT 'NONE',
    "sessionLineId" TEXT,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisionEventReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceBundle_id_tenantId_key" ON "EvidenceBundle"("id", "tenantId");

-- CreateIndex
CREATE INDEX "EvidenceBundle_tenantId_createdAt_idx" ON "EvidenceBundle"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "VisionEvent_id_tenantId_key" ON "VisionEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEvent_tenantId_idempotencyKey_key" ON "VisionEvent"("tenantId", "idempotencyKey");

-- CreateIndex
-- Matches the review-queue ordering exactly (occurredAt DESC, id DESC) so
-- the status-filtered list never sorts a tenant's history per page.
CREATE INDEX "VisionEvent_tenantId_status_occurredAt_id_idx" ON "VisionEvent"("tenantId", "status", "occurredAt" DESC, "id" DESC);

-- CreateIndex
-- The DEFAULT (unfiltered) event list orders by occurredAt DESC, id DESC
-- with no status predicate — it needs its own index without the status
-- column, or every page sorts the tenant's full event history.
CREATE INDEX "VisionEvent_tenantId_occurredAt_id_idx" ON "VisionEvent"("tenantId", "occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "VisionEvent_tenantId_type_idx" ON "VisionEvent"("tenantId", "type");

-- CreateIndex
CREATE INDEX "VisionEvent_tenantId_sessionId_idx" ON "VisionEvent"("tenantId", "sessionId");

-- CreateIndex
CREATE INDEX "VisionEvent_tenantId_unitId_idx" ON "VisionEvent"("tenantId", "unitId");

-- CreateIndex
CREATE INDEX "VisionEvent_tenantId_locationId_idx" ON "VisionEvent"("tenantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEventCandidate_id_tenantId_key" ON "VisionEventCandidate"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEventCandidate_tenantId_eventId_rank_key" ON "VisionEventCandidate"("tenantId", "eventId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEventCandidate_tenantId_eventId_productId_key" ON "VisionEventCandidate"("tenantId", "eventId", "productId");

-- CreateIndex
CREATE INDEX "VisionEventCandidate_productId_idx" ON "VisionEventCandidate"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEventReview_eventId_key" ON "VisionEventReview"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEventReview_id_tenantId_key" ON "VisionEventReview"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VisionEventReview_tenantId_eventId_key" ON "VisionEventReview"("tenantId", "eventId");

-- CreateIndex
CREATE INDEX "VisionEventReview_tenantId_createdAt_idx" ON "VisionEventReview"("tenantId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "EvidenceBundle" ADD CONSTRAINT "EvidenceBundle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EvidenceBundle" ADD CONSTRAINT "EvidenceBundle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_evidenceBundleId_fkey" FOREIGN KEY ("evidenceBundleId") REFERENCES "EvidenceBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "VisionEvent"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "VisionEvent"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_appliedProductId_fkey" FOREIGN KEY ("appliedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_sessionLineId_fkey" FOREIGN KEY ("sessionLineId") REFERENCES "CheckoutSessionLine"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- 1. Quantities and ranks are always positive; scores are normalized [0, 1]
--    confidences (vendor-neutral by construction — adapters must normalize
--    before writing). The application validates first; these backstop any
--    future code path that forgets to.
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_quantity_positive_check"
  CHECK ("quantity" >= 1);
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_evidenceScore_range_check"
  CHECK ("evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1));
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_rank_positive_check"
  CHECK ("rank" >= 1);
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_score_range_check"
  CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1));
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_appliedQuantity_positive_check"
  CHECK ("appliedQuantity" IS NULL OR "appliedQuantity" >= 1);

-- 2. A capture window can never end before it starts.
ALTER TABLE "EvidenceBundle" ADD CONSTRAINT "EvidenceBundle_capture_window_check"
  CHECK ("captureStartedAt" IS NULL OR "captureEndedAt" IS NULL OR "captureEndedAt" >= "captureStartedAt");

-- 3. Cross-tenant reference integrity at the database level (same pattern as
--    Phases 3–5): an event can never live in another tenant's store/unit,
--    reference another tenant's device/session/bundle; candidates can never
--    reference another tenant's event/product; reviews can never reference
--    another tenant's event/product/basket line — even if an unscoped id ever
--    slipped through application code. (MATCH SIMPLE skips the check when the
--    nullable column is NULL — exactly what we want for optional references.)
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_device_same_tenant_fkey"
  FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_session_same_tenant_fkey"
  FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisionEvent" ADD CONSTRAINT "VisionEvent_bundle_same_tenant_fkey"
  FOREIGN KEY ("evidenceBundleId", "tenantId") REFERENCES "EvidenceBundle"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_event_same_tenant_fkey"
  FOREIGN KEY ("eventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VisionEventCandidate" ADD CONSTRAINT "VisionEventCandidate_product_same_tenant_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_event_same_tenant_fkey"
  FOREIGN KEY ("eventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_product_same_tenant_fkey"
  FOREIGN KEY ("appliedProductId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VisionEventReview" ADD CONSTRAINT "VisionEventReview_sessionLine_same_tenant_fkey"
  FOREIGN KEY ("sessionLineId", "tenantId") REFERENCES "CheckoutSessionLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 4. Evidence and decisions are tamper-evident: EvidenceBundle,
--    VisionEventCandidate, and VisionEventReview rows are append-only (same
--    hardening as AuditLog / InventoryMovement). The event row itself stays
--    mutable — its status transitions PENDING_REVIEW → APPROVED/REJECTED/
--    OVERRIDDEN — but what the source proposed and what the reviewer decided
--    can never be rewritten.
CREATE FUNCTION prevent_evidence_bundle_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EvidenceBundle is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_bundle_append_only
  BEFORE UPDATE OR DELETE ON "EvidenceBundle"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_bundle_mutation();

CREATE TRIGGER evidence_bundle_no_truncate
  BEFORE TRUNCATE ON "EvidenceBundle"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_bundle_mutation();

CREATE FUNCTION prevent_vision_candidate_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VisionEventCandidate is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vision_candidate_append_only
  BEFORE UPDATE OR DELETE ON "VisionEventCandidate"
  FOR EACH ROW EXECUTE FUNCTION prevent_vision_candidate_mutation();

CREATE TRIGGER vision_candidate_no_truncate
  BEFORE TRUNCATE ON "VisionEventCandidate"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_vision_candidate_mutation();

CREATE FUNCTION prevent_vision_review_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VisionEventReview is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vision_review_append_only
  BEFORE UPDATE OR DELETE ON "VisionEventReview"
  FOR EACH ROW EXECUTE FUNCTION prevent_vision_review_mutation();

CREATE TRIGGER vision_review_no_truncate
  BEFORE TRUNCATE ON "VisionEventReview"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_vision_review_mutation();
