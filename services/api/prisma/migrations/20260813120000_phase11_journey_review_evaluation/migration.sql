-- Phase 11 — journey shadow runtime, event reviews, controlled test
-- scenarios.
--
-- 1. CustomerJourney gains a final SHADOW decision (READY_TO_SETTLE_SHADOW /
--    NEEDS_EVENT_REVIEW / NEEDS_JOURNEY_REVIEW / FAILED) set at exit
--    reconciliation and recomputed after each review. The decision is a
--    recorded conclusion only — nothing here references checkout, order,
--    or payment tables.
-- 2. CustomerJourneyEventReview records what a human reviewer decided about
--    one observation (APPROVE / REJECT / CORRECT). The observation row is
--    never rewritten; the basket fold applies the latest review per event
--    on read. Rows are append-only at the database level, and the service
--    writes an AuditLog row in the same transaction.
-- 3. VideoGroundTruth gains the controlled test-scenario label the
--    evaluation dashboard breaks accuracy down by.
-- 4. CustomerJourneyEvent rows become append-only at the database level
--    too — until now that invariant was service discipline only. The
--    journey cascade delete is deliberately vetoed by this trigger: no
--    journey delete path exists, and observations must outlive mistakes.

-- CreateEnum
CREATE TYPE "CustomerJourneyDecision" AS ENUM ('READY_TO_SETTLE_SHADOW', 'NEEDS_EVENT_REVIEW', 'NEEDS_JOURNEY_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "JourneyEventReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'CORRECT');

-- CreateEnum
CREATE TYPE "CvTestScenario" AS ENUM ('PICKUP_SINGLE', 'RETURN_SINGLE', 'FALSE_TOUCH', 'TWO_SIMILAR_PICK_ONE', 'TWO_VISIBLE_PICK_ONE', 'VLM_UNAVAILABLE', 'VLM_INVALID_SKU');

-- AlterTable
ALTER TABLE "CustomerJourney" ADD COLUMN "decision" "CustomerJourneyDecision",
ADD COLUMN "decisionReason" TEXT,
ADD COLUMN "decidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VideoGroundTruth" ADD COLUMN "testType" "CvTestScenario";

-- CreateTable
CREATE TABLE "CustomerJourneyEventReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "decision" "JourneyEventReviewDecision" NOT NULL,
    "correctedEventType" "CustomerJourneyEventType",
    "correctedProductId" TEXT,
    "correctedSku" TEXT,
    "correctedProductName" TEXT,
    "correctedQuantity" INTEGER,
    "reason" TEXT,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerJourneyEventReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (anchor for the review table's same-tenant composite FK)
CREATE UNIQUE INDEX "CustomerJourneyEvent_id_tenantId_key" ON "CustomerJourneyEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerJourneyEventReview_id_tenantId_key" ON "CustomerJourneyEventReview"("id", "tenantId");

-- CreateIndex
CREATE INDEX "CustomerJourneyEventReview_tenantId_journeyId_createdAt_idx" ON "CustomerJourneyEventReview"("tenantId", "journeyId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerJourneyEventReview_tenantId_eventId_createdAt_idx" ON "CustomerJourneyEventReview"("tenantId", "eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "CustomerJourney"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CustomerJourneyEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_correctedProductId_fkey" FOREIGN KEY ("correctedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same-tenant composite FKs (AGENTS.md: tenancy — repository scoping alone
-- is not enough). Actions mirror each sibling single-column FK above.
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_journey_same_tenant_fkey" FOREIGN KEY ("journeyId", "tenantId") REFERENCES "CustomerJourney"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_event_same_tenant_fkey" FOREIGN KEY ("eventId", "tenantId") REFERENCES "CustomerJourneyEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "CustomerJourneyEventReview_product_same_tenant_fkey" FOREIGN KEY ("correctedProductId", "tenantId") REFERENCES "Product"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints — the correction payload is well-formed at the
-- database level, not just in the service:
--   * CORRECT must carry a product and a quantity;
--   * APPROVE/REJECT must carry no correction fields at all;
--   * a corrected quantity stays inside the append path's 1..100 bound;
--   * a corrected event type can only be a product event.
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "journey_review_quantity_range"
  CHECK ("correctedQuantity" IS NULL OR ("correctedQuantity" >= 1 AND "correctedQuantity" <= 100));
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "journey_review_correct_payload"
  CHECK (
    ("decision" = 'CORRECT' AND "correctedProductId" IS NOT NULL AND "correctedQuantity" IS NOT NULL)
    OR ("decision" <> 'CORRECT'
        AND "correctedEventType" IS NULL
        AND "correctedProductId" IS NULL
        AND "correctedSku" IS NULL
        AND "correctedProductName" IS NULL
        AND "correctedQuantity" IS NULL)
  );
ALTER TABLE "CustomerJourneyEventReview" ADD CONSTRAINT "journey_review_corrected_event_type"
  CHECK ("correctedEventType" IS NULL OR "correctedEventType" IN ('PRODUCT_PICKUP', 'PRODUCT_RETURN'));

-- A decision and its timestamp arrive (and clear) together.
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "journey_decision_timestamp_paired"
  CHECK (("decision" IS NULL) = ("decidedAt" IS NULL));

-- Journey observations and review decisions are tamper-evident: rows are
-- append-only at the database level (same hardening as AuditLog /
-- InventoryMovement / VisionEventReview).
CREATE FUNCTION prevent_journey_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CustomerJourneyEvent is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journey_event_append_only
  BEFORE UPDATE OR DELETE ON "CustomerJourneyEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_journey_event_mutation();

CREATE TRIGGER journey_event_no_truncate
  BEFORE TRUNCATE ON "CustomerJourneyEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_journey_event_mutation();

CREATE FUNCTION prevent_journey_review_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CustomerJourneyEventReview is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journey_review_append_only
  BEFORE UPDATE OR DELETE ON "CustomerJourneyEventReview"
  FOR EACH ROW EXECUTE FUNCTION prevent_journey_review_mutation();

CREATE TRIGGER journey_review_no_truncate
  BEFORE TRUNCATE ON "CustomerJourneyEventReview"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_journey_review_mutation();
