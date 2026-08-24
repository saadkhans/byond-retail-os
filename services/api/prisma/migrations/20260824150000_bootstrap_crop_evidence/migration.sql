-- One-SKU bootstrap (Codex P1) — STRUCTURED operator-crop evidence.
-- A manual crop the operator approved supersedes the fusion run's
-- automatic crop as the reviewed observation's evidence. The association
-- travels as an OPAQUE VideoArtifact id in structured columns — never
-- parsed from free-form notes, never a file path, URL, or raw media:
--  * PilotObservationReview.operatorCropArtifactId — written by the
--    bootstrap review flow (validated tenant-scoped + same-video), the
--    source of truth Phase 18 reads through observations().
--  * CvDatasetCandidate.evidenceCropArtifactId — copied at candidate
--    refresh so the export manifest names the crop the operator actually
--    approved instead of the rejected automatic one.

-- AlterTable
ALTER TABLE "PilotObservationReview" ADD COLUMN "operatorCropArtifactId" TEXT;

-- AlterTable
ALTER TABLE "CvDatasetCandidate" ADD COLUMN "evidenceCropArtifactId" TEXT;
