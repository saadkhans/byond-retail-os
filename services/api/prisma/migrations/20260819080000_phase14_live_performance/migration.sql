-- Phase 14 — live speed pilot testing: per-stage timing statistics on
-- the live session row (p50/p95/max/avg/count per pipeline stage).
-- Observability only — controlled numeric aggregates written by the
-- sampling loop; never URLs, credentials, pixels, or free text, and
-- never read by any decision path.

-- AlterTable
ALTER TABLE "LiveCameraSession" ADD COLUMN "performance" JSONB;
