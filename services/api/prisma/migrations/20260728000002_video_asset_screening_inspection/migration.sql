-- Phase 10 follow-up (Codex P1: require an inspected preview before
-- approval): server-side screening inspection evidence.
--
-- Before this, APPROVE only required a QUARANTINED row — a caller could
-- release an upload (including one accepted through the unsafe
-- unscreened-upload override) without any successful real-media preview,
-- bypassing the mandatory human backstop blind. These nullable columns
-- record the SERVER'S OWN evidence that a real inspection happened:
-- they are stamped ONLY inside the guarded screening-preview serve
-- authorization (same advisory-lock transaction that re-reads QUARANTINED
-- and writes the byte-exposing READ audit), ONLY when at least one frame
-- was actually served, and ONLY when the configured extractor reads real
-- bytes (the preview 503s otherwise before any extraction) — so no
-- simulated path can ever mint evidence. The APPROVE screening decision
-- requires fresh evidence (recorded recently, frames > 0) and 409s
-- without it; REJECT never needs evidence (rejecting blind is safe).
-- Evidence is cleared on EVERY status transition: it is QUARANTINED-scoped
-- and single-use, and a fresh QUARANTINED publish after a re-upload must
-- start with none.

ALTER TABLE "VideoAsset" ADD COLUMN "screeningInspectedAt" TIMESTAMP(3);
ALTER TABLE "VideoAsset" ADD COLUMN "screeningInspectedBy" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "screeningInspectedFrames" INTEGER;
