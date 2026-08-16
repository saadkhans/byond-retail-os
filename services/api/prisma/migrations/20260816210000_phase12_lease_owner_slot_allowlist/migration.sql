-- Phase 12 blocker patch, round 3.
--
-- 1. CameraPilotRun.leaseOwner: each RUNNING replay attempt holds an
--    ownership token; heartbeats and finalization writes are conditional
--    on (status = RUNNING AND leaseOwner matches), so a reclaimed or
--    completed row can never be overwritten by an attempt that lost its
--    lease.
-- 2. credentialRef tightens from the CAMERA_SECRET_SLOT_* namespace to an
--    explicit server-recognized allowlist — arbitrary caller-composed
--    suffixes could smuggle letter-separated PANs or password-like words
--    past shape checks. Existing rows outside the allowlist are detached
--    (set NULL), not preserved.

-- AlterTable
ALTER TABLE "CameraPilotRun" ADD COLUMN "leaseOwner" TEXT;

-- Detach any credential reference outside the allowlist before the CHECK.
UPDATE "CameraSource" SET "credentialRef" = NULL
  WHERE "credentialRef" IS NOT NULL
    AND "credentialRef" NOT IN (
      'CAMERA_SECRET_SLOT_TEST',
      'CAMERA_SECRET_SLOT_ALPHA',
      'CAMERA_SECRET_SLOT_DEMO',
      'CAMERA_SECRET_SLOT_EDGE_CAM_A',
      'CAMERA_SECRET_SLOT_EDGE_CAM_B'
    );

ALTER TABLE "CameraSource" DROP CONSTRAINT "camera_source_credential_ref_slot_format";
ALTER TABLE "CameraSource" ADD CONSTRAINT "camera_source_credential_ref_allowlist"
  CHECK ("credentialRef" IS NULL OR "credentialRef" IN (
    'CAMERA_SECRET_SLOT_TEST',
    'CAMERA_SECRET_SLOT_ALPHA',
    'CAMERA_SECRET_SLOT_DEMO',
    'CAMERA_SECRET_SLOT_EDGE_CAM_A',
    'CAMERA_SECRET_SLOT_EDGE_CAM_B'
  ));
