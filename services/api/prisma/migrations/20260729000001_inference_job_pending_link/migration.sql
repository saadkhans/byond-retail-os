-- Phase 10 follow-up (Codex P1: make crop job creation and artifact linking
-- crash-recoverable): non-claimable PENDING_LINK creation state.
--
-- Crop → job creation commits a durably QUEUED job BEFORE video-ingest
-- writes the artifact → job link in a SEPARATE transaction. A crash in
-- between left a CLAIMABLE job that the asset DELETE flow could never
-- discover (deletion enumerates only jobs reachable through
-- VideoArtifact."inferenceJobId"), so the crop's media was removed while
-- claimable work survived — and the retry could not repair it either,
-- because the artifact is 404-hidden once its asset is gone.
--
-- PENDING_LINK closes the window as a LIFECYCLE STATE: the caller creates
-- the job PENDING_LINK (never claimed — every claim path pins
-- status = 'QUEUED'), commits its link, and only then publishes
-- PENDING_LINK → QUEUED. A crash in the window leaves a non-claimable row
-- that is still discoverable by its deterministic idempotency key
-- ('video-crop:<artifactId>') and cancellable exactly like a QUEUED job.

-- New lifecycle value, ordered ahead of QUEUED (it precedes it in the
-- lifecycle). Postgres 12+ allows ADD VALUE inside a transaction as long as
-- the NEW value is not USED in the same transaction: nothing below
-- references 'PENDING_LINK'. The column default stays 'QUEUED' (Phase 9
-- creation is byte-identical); the queue sets PENDING_LINK explicitly on
-- the opt-in create path, so no ALTER COLUMN (which would use the new
-- value) is needed here.
ALTER TYPE "InferenceJobStatus" ADD VALUE IF NOT EXISTS 'PENDING_LINK' BEFORE 'QUEUED';

-- Timestamp coherence for the new state, expressed WITHOUT naming it (the
-- PG 12+ same-transaction rule): "a job that has not been claimed carries
-- neither timestamp" now covers PENDING_LINK as well as QUEUED, because
-- the guard lists the STARTED/terminal statuses instead of the unstarted
-- one. Every other InferenceJob CHECK already holds for PENDING_LINK
-- unchanged: it is NON-TERMINAL, so terminal_completedAt_check
-- ('FAILED','CANCELLED' only) does not apply; it carries no errorCode
-- (error_only_failed_check), no lease (running_lease_check ties leases to
-- RUNNING), and no vision-event link (visionEvent_succeeded_check).
ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_queued_timestamps_check";
ALTER TABLE "InferenceJob" ADD CONSTRAINT "InferenceJob_unclaimed_timestamps_check"
  CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
    OR ("startedAt" IS NULL AND "completedAt" IS NULL));
