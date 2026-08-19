-- Phase 13 final blockers (Codex P1): detected live work must be durable
-- INDEPENDENTLY of the best-effort counters — the detection-time intent
-- LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW joins the controlled
-- vocabulary so a processed window whose counter persist failed still
-- fences the journey from READY_TO_SETTLE_SHADOW.

ALTER TABLE "LiveCameraSessionFinalizationIntent" DROP CONSTRAINT "live_finalization_intent_reason_vocabulary";
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
    'JOURNEY_FINALIZATION_RETRY_REQUIRED',
    'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW'
  ));
