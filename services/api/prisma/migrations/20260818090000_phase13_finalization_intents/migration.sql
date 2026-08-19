-- Phase 13 lifecycle simplification — durable ADDITIVE finalization
-- intents (Codex P1): a single overwritable errorCode cannot carry
-- several simultaneous fail-closed reasons. One row per (session,
-- reason), idempotent via the unique pair; the finalizer materializes
-- every unmaterialized intent into a review-required journey marker
-- before the journey may exit, and a session with any intent can never
-- conclude READY_TO_SETTLE_SHADOW. The reason vocabulary is CONTROLLED
-- at both layers (service constant + the CHECK below).

-- CreateTable
CREATE TABLE "LiveCameraSessionFinalizationIntent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "liveSessionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "materializedAt" TIMESTAMP(3),

    CONSTRAINT "LiveCameraSessionFinalizationIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveCameraSessionFinalizationIntent_id_tenantId_key" ON "LiveCameraSessionFinalizationIntent"("id", "tenantId");
CREATE UNIQUE INDEX "LiveCameraSessionFinalizationIntent_liveSessionId_reason_key" ON "LiveCameraSessionFinalizationIntent"("liveSessionId", "reason");
CREATE INDEX "LiveCameraSessionFinalizationIntent_tenantId_liveSessionId_idx" ON "LiveCameraSessionFinalizationIntent"("tenantId", "liveSessionId");

-- AddForeignKey
ALTER TABLE "LiveCameraSessionFinalizationIntent" ADD CONSTRAINT "LiveCameraSessionFinalizationIntent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveCameraSessionFinalizationIntent" ADD CONSTRAINT "LiveCameraSessionFinalizationIntent_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveCameraSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same-tenant composite FK (AGENTS.md: tenancy).
ALTER TABLE "LiveCameraSessionFinalizationIntent" ADD CONSTRAINT "LiveCameraSessionFinalizationIntent_session_same_tenant_fkey" FOREIGN KEY ("liveSessionId", "tenantId") REFERENCES "LiveCameraSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Controlled reason vocabulary.
ALTER TABLE "LiveCameraSessionFinalizationIntent" ADD CONSTRAINT "live_finalization_intent_reason_vocabulary"
  CHECK ("reason" IN (
    'LIVE_WINDOW_PROCESS_FAILED',
    'PENDING_MOTION_AT_STOP',
    'WINDOW_DETECTED_NOT_PROCESSED',
    'LIVE_WINDOW_DRAIN_TIMEOUT',
    'STARTUP_FINALIZATION_REQUIRED',
    'STALE_SESSION_RECLAIMED',
    'LIVE_FRAME_SCREENING_UNAVAILABLE',
    'LIVE_FRAME_SENSITIVE_CONTENT',
    'JOURNEY_FINALIZATION_RETRY_REQUIRED'
  ));

-- Intent rows are never deleted; materializedAt is the only mutable
-- column (append + single-column stamp). Enforced at the DB level.
CREATE FUNCTION prevent_finalization_intent_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LiveCameraSessionFinalizationIntent is append-only: DELETE is not allowed';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
     OR OLD."liveSessionId" IS DISTINCT FROM NEW."liveSessionId"
     OR OLD."reason" IS DISTINCT FROM NEW."reason"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'LiveCameraSessionFinalizationIntent allows only materializedAt updates';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER finalization_intent_guard
  BEFORE UPDATE OR DELETE ON "LiveCameraSessionFinalizationIntent"
  FOR EACH ROW EXECUTE FUNCTION prevent_finalization_intent_mutation();
