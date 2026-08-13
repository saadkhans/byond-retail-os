-- Phase 10 follow-up (Codex P1: keep staged deletion pending until the
-- in-flight put drains): DURABLE media-write state for a video asset.
--
-- DELETE decided whether an upload's media write could still be in flight
-- by INFERRING it from the row: a fresh delete looked at
-- status = 'PENDING_MEDIA', and a REPLAY (deletedAt already set) assumed
-- the write must have drained because the soft-delete was durable. That
-- inference is unobservable: a put whose advisory-lock liveness check
-- passed BEFORE the original soft-delete committed is still in flight
-- during the replay, so the replay removed an empty prefix, stamped the
-- exactly-once completion marker, and only THEN did the bytes land —
-- completion recorded before the media it claims to have removed existed.
--
-- The column below makes the write's outcome DURABLE instead. The upload
-- claims PENDING in the SAME advisory-locked transaction as its pre-put
-- liveness read (so a concurrent soft-delete either observes the claim or
-- committed first, in which case no put runs at all), writes SUCCEEDED the
-- moment storage.put returns, and FAILED when it throws. DELETE — fresh or
-- replayed — may record the media-removal completion ONLY when the state is
-- RESOLVED; while it is PENDING the removal still runs, the completion
-- marker is deliberately left unset, and the audit names the outstanding
-- drain obligation. A later replay, once the write resolved, drains the
-- prefix and records the completion exactly once (the mediaRemovedAt CAS
-- stays the exactly-once authority).
--
-- NULLABLE with NO backfill on purpose: NULL means "no durable media write
-- was ever attempted for this row" — the honest reading for pre-existing
-- rows (their upload completed long ago, nothing is in flight) and for rows
-- rejected by the pre-storage screen before any put. Only PENDING withholds
-- the completion, so NULL keeps every existing row's delete behaviour
-- byte-identical.

-- CreateEnum
CREATE TYPE "VideoMediaWriteState" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "VideoAsset" ADD COLUMN "mediaWriteState" "VideoMediaWriteState";
