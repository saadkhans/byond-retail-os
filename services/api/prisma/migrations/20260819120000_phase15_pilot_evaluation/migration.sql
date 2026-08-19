-- Phase 15 — live pilot evaluation loop (SHADOW ONLY): evaluation runs
-- group live sessions for accuracy/speed measurement; operator reviews
-- are APPEND-ONLY labels over live CV observations (enforced by trigger
-- below), with server-side predicted* snapshots. No table here touches
-- checkout, order, payment, or inventory state.

-- CreateEnum
CREATE TYPE "PilotEvaluationRunStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');
CREATE TYPE "PilotObservationVerdict" AS ENUM ('CORRECT', 'INCORRECT', 'UNCERTAIN', 'FALSE_TOUCH', 'WRONG_SKU', 'WRONG_ACTION', 'MISSED_EVENT');
CREATE TYPE "PilotExpectedAction" AS ENUM ('PICKUP', 'RETURN', 'NO_OP', 'UNKNOWN');

-- CreateTable
CREATE TABLE "PilotEvaluationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PilotEvaluationRunStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PilotEvaluationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PilotEvaluationSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "liveSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PilotEvaluationSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PilotObservationReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "liveSessionId" TEXT,
    "journeyEventId" TEXT,
    "verdict" "PilotObservationVerdict" NOT NULL,
    "expectedAction" "PilotExpectedAction" NOT NULL,
    "expectedProductId" TEXT,
    "expectedSku" TEXT,
    "predictedProductId" TEXT,
    "predictedSku" TEXT,
    "predictedAction" "PilotExpectedAction",
    "notes" TEXT,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PilotObservationReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PilotEvaluationRun_id_tenantId_key" ON "PilotEvaluationRun"("id", "tenantId");
CREATE INDEX "PilotEvaluationRun_tenantId_createdAt_idx" ON "PilotEvaluationRun"("tenantId", "createdAt" DESC);
CREATE UNIQUE INDEX "PilotEvaluationSession_id_tenantId_key" ON "PilotEvaluationSession"("id", "tenantId");
CREATE UNIQUE INDEX "PilotEvaluationSession_evaluationRunId_liveSessionId_key" ON "PilotEvaluationSession"("evaluationRunId", "liveSessionId");
CREATE INDEX "PilotEvaluationSession_tenantId_evaluationRunId_idx" ON "PilotEvaluationSession"("tenantId", "evaluationRunId");
CREATE UNIQUE INDEX "PilotObservationReview_id_tenantId_key" ON "PilotObservationReview"("id", "tenantId");
CREATE INDEX "PilotObservationReview_tenantId_evaluationRunId_createdAt_idx" ON "PilotObservationReview"("tenantId", "evaluationRunId", "createdAt");
CREATE INDEX "PilotObservationReview_tenantId_journeyEventId_createdAt_idx" ON "PilotObservationReview"("tenantId", "journeyEventId", "createdAt");

-- AddForeignKey
ALTER TABLE "PilotEvaluationRun" ADD CONSTRAINT "PilotEvaluationRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotEvaluationRun" ADD CONSTRAINT "PilotEvaluationRun_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotEvaluationSession" ADD CONSTRAINT "PilotEvaluationSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotEvaluationSession" ADD CONSTRAINT "PilotEvaluationSession_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "PilotEvaluationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotEvaluationSession" ADD CONSTRAINT "PilotEvaluationSession_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveCameraSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "PilotObservationReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "PilotObservationReview_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "PilotEvaluationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "PilotObservationReview_journeyEventId_fkey" FOREIGN KEY ("journeyEventId") REFERENCES "CustomerJourneyEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "PilotObservationReview_expectedProductId_fkey" FOREIGN KEY ("expectedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same-tenant composite FKs (AGENTS.md: tenancy) — a known foreign id can
-- never link evaluation state across tenants.
ALTER TABLE "PilotEvaluationSession" ADD CONSTRAINT "PilotEvaluationSession_run_same_tenant_fkey" FOREIGN KEY ("evaluationRunId", "tenantId") REFERENCES "PilotEvaluationRun"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotEvaluationSession" ADD CONSTRAINT "PilotEvaluationSession_live_same_tenant_fkey" FOREIGN KEY ("liveSessionId", "tenantId") REFERENCES "LiveCameraSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "PilotObservationReview_run_same_tenant_fkey" FOREIGN KEY ("evaluationRunId", "tenantId") REFERENCES "PilotEvaluationRun"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "PilotObservationReview_event_same_tenant_fkey" FOREIGN KEY ("journeyEventId", "tenantId") REFERENCES "CustomerJourneyEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Verdict shape: MISSED_EVENT labels an interaction the CV never emitted
-- an event for (no journeyEventId, but a session attribution); every
-- other verdict labels one concrete observation.
ALTER TABLE "PilotObservationReview" ADD CONSTRAINT "pilot_review_missed_event_shape"
  CHECK (
    ("verdict" = 'MISSED_EVENT' AND "journeyEventId" IS NULL AND "liveSessionId" IS NOT NULL)
    OR ("verdict" <> 'MISSED_EVENT' AND "journeyEventId" IS NOT NULL)
  );

-- APPEND-ONLY audit (same discipline as the finalization intents): a
-- review row is never updated or deleted — corrections append a NEWER
-- row and metrics read the latest per observation.
CREATE FUNCTION prevent_pilot_review_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PilotObservationReview is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pilot_review_append_only
  BEFORE UPDATE OR DELETE ON "PilotObservationReview"
  FOR EACH ROW EXECUTE FUNCTION prevent_pilot_review_mutation();
