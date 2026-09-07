-- Phase 22: planogram binding of a test clip at upload. The rack code
-- names an ACTIVE PlanogramRack at the asset's store (validated in the
-- service before any byte is stored; no FK because racks are versioned
-- rows re-created on publish); the frame region is a normalized
-- rectangle (null = the rack fills the frame).
ALTER TABLE "VideoAsset" ADD COLUMN "planogramRackCode" TEXT;
ALTER TABLE "VideoAsset" ADD COLUMN "rackFrameRegion" JSONB;
