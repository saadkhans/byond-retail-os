-- Phase 9: CV inference adapter & event queue foundation.
--
-- Provider-neutral by construction: adapterKey/modelKey/modelVersion are
-- OPAQUE strings; no camera/detector/(V)LM-specific columns exist and no
-- runtime ML or video dependency is introduced. Jobs carry a SAFE input
-- descriptor only (screened JSON — no raw media, no storage keys or signed
-- URLs, no credentials). A SUCCEEDED job's result converts into a Phase 7
-- VisionEvent through the existing ingest contract — inference NEVER mutates
-- the basket or inventory itself.

-- CreateEnum
CREATE TYPE "InferenceJobType" AS ENUM ('TRACKING_EVENT', 'SHELF_AUDIT', 'PRODUCT_RECOGNITION', 'OCR_REVIEW', 'VLM_REVIEW', 'EXIT_RECONCILIATION');

-- CreateEnum
CREATE TYPE "InferenceJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "InferenceJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "unitId" TEXT,
    "deviceId" TEXT,
    "sessionId" TEXT,
    "jobType" "InferenceJobType" NOT NULL,
    "status" "InferenceJobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "sourceType" "EvidenceSourceType" NOT NULL DEFAULT 'VISION',
    "sourceId" TEXT,
    "adapterKey" TEXT,
    "inputDescriptor" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "idempotencyKey" TEXT,
    "visionEventId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InferenceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InferenceResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eventType" "VisionEventType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "evidenceScore" DOUBLE PRECISION,
    "evidenceQuality" "EvidenceQuality",
    "modelKey" TEXT,
    "modelVersion" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InferenceResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InferenceCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "label" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InferenceCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InferenceJob_id_tenantId_key" ON "InferenceJob"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceJob_tenantId_idempotencyKey_key" ON "InferenceJob"("tenantId", "idempotencyKey");

-- CreateIndex
-- Matches the queue claim ordering exactly (priority DESC, requestedAt ASC,
-- id ASC) under the tenant + status predicate, so claiming never sorts a
-- tenant's full job history.
CREATE INDEX "InferenceJob_tenantId_status_priority_requestedAt_id_idx" ON "InferenceJob"("tenantId", "status", "priority" DESC, "requestedAt", "id");

-- CreateIndex
-- The DEFAULT (unfiltered) job list orders by requestedAt DESC, id DESC.
CREATE INDEX "InferenceJob_tenantId_requestedAt_id_idx" ON "InferenceJob"("tenantId", "requestedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "InferenceJob_tenantId_jobType_idx" ON "InferenceJob"("tenantId", "jobType");

-- CreateIndex
CREATE INDEX "InferenceJob_tenantId_sessionId_idx" ON "InferenceJob"("tenantId", "sessionId");

-- CreateIndex
CREATE INDEX "InferenceJob_tenantId_unitId_idx" ON "InferenceJob"("tenantId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceResult_jobId_key" ON "InferenceResult"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceResult_id_tenantId_key" ON "InferenceResult"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceResult_tenantId_jobId_key" ON "InferenceResult"("tenantId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceCandidate_id_tenantId_key" ON "InferenceCandidate"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceCandidate_tenantId_resultId_rank_key" ON "InferenceCandidate"("tenantId", "resultId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "InferenceCandidate_tenantId_resultId_sku_key" ON "InferenceCandidate"("tenantId", "resultId", "sku");

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_visionEventId_fkey" FOREIGN KEY ("visionEventId") REFERENCES "VisionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "InferenceJob"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InferenceCandidate" ADD CONSTRAINT "InferenceCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InferenceCandidate" ADD CONSTRAINT "InferenceCandidate_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "InferenceResult"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- 1. Priority stays in the 0..1000 API range; result deltas are never zero
--    and negative ONLY for PRODUCT_RETURN (and a PRODUCT_RETURN suggestion is
--    always negative — the sign carries the direction, the VisionEvent
--    conversion emits the magnitude, matching the Phase 8 mapper); scores are
--    normalized [0, 1] confidences; ranks are positive. The application
--    validates first; these backstop any future code path that forgets to.
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_priority_range_check"
  CHECK ("priority" >= 0 AND "priority" <= 1000);
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_attempts_nonnegative_check"
  CHECK ("attempts" >= 0);
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_quantityDelta_nonzero_check"
  CHECK ("quantityDelta" <> 0);
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_return_direction_check"
  CHECK (("quantityDelta" < 0) = ("eventType" = 'PRODUCT_RETURN'));
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_evidenceScore_range_check"
  CHECK ("evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1));
ALTER TABLE "InferenceCandidate" ADD CONSTRAINT "InferenceCandidate_rank_positive_check"
  CHECK ("rank" >= 1);
ALTER TABLE "InferenceCandidate" ADD CONSTRAINT "InferenceCandidate_score_range_check"
  CHECK ("score" >= 0 AND "score" <= 1);

-- 2. Lifecycle/timestamp coherence: a QUEUED job has neither timestamp, a
--    RUNNING job has started but not completed, a SUCCEEDED job has both,
--    and every terminal job has completedAt. Error codes exist exactly on
--    FAILED jobs; a vision-event link exists only on SUCCEEDED jobs.
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_queued_timestamps_check"
  CHECK ("status" <> 'QUEUED' OR ("startedAt" IS NULL AND "completedAt" IS NULL));
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_running_timestamps_check"
  CHECK ("status" <> 'RUNNING' OR ("startedAt" IS NOT NULL AND "completedAt" IS NULL));
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_succeeded_timestamps_check"
  CHECK ("status" <> 'SUCCEEDED' OR ("startedAt" IS NOT NULL AND "completedAt" IS NOT NULL));
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_terminal_completedAt_check"
  CHECK ("status" NOT IN ('FAILED', 'CANCELLED') OR "completedAt" IS NOT NULL);
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_error_only_failed_check"
  CHECK (("status" = 'FAILED') = ("errorCode" IS NOT NULL));
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_visionEvent_succeeded_check"
  CHECK ("visionEventId" IS NULL OR "status" = 'SUCCEEDED');
-- A RUNNING job is exactly a LEASED job: claims take a lease (worker-crash
-- reclaim depends on it), and every other status carries none.
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_running_lease_check"
  CHECK (("status" = 'RUNNING') = ("leaseExpiresAt" IS NOT NULL));

-- 3. Cross-tenant reference integrity at the database level (same pattern as
--    Phases 3-7): a job can never reference another tenant's store/unit/
--    device/session/vision event; results can never reference another
--    tenant's job; candidates can never reference another tenant's result —
--    even if an unscoped id ever slipped through application code. (MATCH
--    SIMPLE skips the check when the nullable column is NULL — exactly what
--    we want for optional references.)
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_device_same_tenant_fkey"
  FOREIGN KEY ("deviceId", "tenantId") REFERENCES "Device"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_session_same_tenant_fkey"
  FOREIGN KEY ("sessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_visionEvent_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId") REFERENCES "VisionEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The creator too: an actor from another tenant must never persist as this
-- job's createdById. User(id) is already unique; the composite unique below
-- exists purely as the FK anchor. (MATCH SIMPLE: a NULL createdById — system
-- flows — skips the check.)
CREATE UNIQUE INDEX "User_id_tenantId_key" ON "User"("id", "tenantId");
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_creator_same_tenant_fkey"
  FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InferenceResult" ADD CONSTRAINT "InferenceResult_job_same_tenant_fkey"
  FOREIGN KEY ("jobId", "tenantId") REFERENCES "InferenceJob"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "InferenceCandidate" ADD CONSTRAINT "InferenceCandidate_result_same_tenant_fkey"
  FOREIGN KEY ("resultId", "tenantId") REFERENCES "InferenceResult"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 4. Adapter output is tamper-evident: InferenceResult and InferenceCandidate
--    rows are append-only (same hardening as AuditLog / InventoryMovement /
--    the Phase 7 evidence tables). The job row itself stays mutable — its
--    status transitions QUEUED → RUNNING → SUCCEEDED/FAILED — but what an
--    adapter produced can never be rewritten.
CREATE FUNCTION prevent_inference_result_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'InferenceResult is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inference_result_append_only
  BEFORE UPDATE OR DELETE ON "InferenceResult"
  FOR EACH ROW EXECUTE FUNCTION prevent_inference_result_mutation();

CREATE TRIGGER inference_result_no_truncate
  BEFORE TRUNCATE ON "InferenceResult"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_inference_result_mutation();

CREATE FUNCTION prevent_inference_candidate_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'InferenceCandidate is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inference_candidate_append_only
  BEFORE UPDATE OR DELETE ON "InferenceCandidate"
  FOR EACH ROW EXECUTE FUNCTION prevent_inference_candidate_mutation();

CREATE TRIGGER inference_candidate_no_truncate
  BEFORE TRUNCATE ON "InferenceCandidate"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_inference_candidate_mutation();
