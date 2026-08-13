-- Phase 10 follow-up (Codex review cycle 3): parameter-exact replays.
--
-- A VideoExtractionRequest row previously recorded only the idempotency key
-- and the produced artifact ids, so a client reusing a key on the same asset
-- with CHANGED parameters (different timestamp, box, reason, interval, or
-- limit) was silently handed the old batch as if it answered the new
-- request. The stored artifact rows cannot reconstruct the original request
-- for interval sampling (maxFrames is unrecoverable once the duration cap
-- wins), so the request itself is recorded: a canonical fingerprint (fixed
-- operation tag, fixed field order, defaults applied) written in the SAME
-- transaction as the batch. Replays compare fingerprints and 409 on any
-- difference. Nullable: rows recorded before this column existed have no
-- fingerprint and fail closed (409) rather than replaying unverifiably.
--
-- DDL only — the append-only row triggers on this table are unaffected.

-- AlterTable
ALTER TABLE "VideoExtractionRequest" ADD COLUMN "requestFingerprint" TEXT;
