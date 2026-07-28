-- Phase 10 follow-up (Codex P2: exactly-once media-removal completion
-- evidence): DB compare-and-set marker for a video asset's media removal.
--
-- Before this, the "media removal completed" audit entry was triggered by
-- the storage adapter's stat-then-rm "did anything exist" report — which
-- two concurrent removals (initial attempt + idempotent replay) can BOTH
-- observe as true (duplicated completion evidence), and which a replay
-- observes as false when the bytes are already gone even if the earlier
-- attempt's completion audit never committed (permanently missing
-- completion evidence). The nullable timestamp below is the exactly-once
-- authority instead: completion is recorded via
-- `updateMany WHERE mediaRemovedAt IS NULL SET mediaRemovedAt = now()` in
-- ONE transaction with the completion audit entry, so exactly one caller
-- ever writes the evidence — regardless of what the filesystem reported —
-- and a replay over already-removed bytes can still REPAIR a missing
-- completion record. Shared by the screening-rejection removal and the
-- soft-delete cleanup (the audit reason distinguishes them).

ALTER TABLE "VideoAsset" ADD COLUMN "mediaRemovedAt" TIMESTAMP(3);
