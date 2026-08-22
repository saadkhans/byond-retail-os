-- Phase 18 — dataset improvement & model tuning (SHADOW ONLY, advisory).
-- A dataset improvement run turns REVIEWED/CORRECTED Phase 15/16 labels
-- into training-ready METADATA: candidate references, quality reporting,
-- deterministic split planning, and a safe export manifest for OFFLINE
-- tuning. Never stored here: raw frames, crops, video, embeddings, model
-- weights, RTSP URLs, file paths, or credential slots. Nothing in this
-- phase touches checkout, order, payment, or inventory state, and it
-- never mutates the review/scenario records it reads.

-- CreateEnum
CREATE TYPE "CvDatasetImprovementRunStatus" AS ENUM ('DRAFT', 'READY', 'EXPORTED', 'ARCHIVED');
CREATE TYPE "CvDatasetPurpose" AS ENUM ('SKU_CLASSIFICATION', 'ACTION_RECOGNITION', 'FALSE_TOUCH_FILTERING', 'MISSED_EVENT_RECOVERY', 'CALIBRATION_VALIDATION', 'MIXED');
CREATE TYPE "CvDatasetCandidateSourceType" AS ENUM ('LIVE_REVIEW', 'MISSED_EVENT', 'PROTOCOL_SCENARIO', 'DATASET_EXPORT_ITEM');
CREATE TYPE "CvDatasetSplit" AS ENUM ('TRAIN', 'VALIDATION', 'TEST', 'HOLDOUT');
CREATE TYPE "CvDatasetEligibility" AS ENUM ('ELIGIBLE', 'EXCLUDED');

-- CreateTable
CREATE TABLE "CvDatasetImprovementRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceEvaluationRunId" TEXT,
    "sourceTestProtocolId" TEXT,
    "sourceCalibrationProfileId" TEXT,
    "name" TEXT NOT NULL,
    "status" "CvDatasetImprovementRunStatus" NOT NULL DEFAULT 'DRAFT',
    "purpose" "CvDatasetPurpose" NOT NULL,
    "trainSplitPercent" INTEGER NOT NULL,
    "validationSplitPercent" INTEGER NOT NULL,
    "testSplitPercent" INTEGER NOT NULL,
    "minReviewedExamplesPerSku" INTEGER NOT NULL,
    "minReviewedExamplesPerAction" INTEGER NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "exportedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "CvDatasetImprovementRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CvDatasetCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceType" "CvDatasetCandidateSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "liveSessionId" TEXT,
    "evaluationRunId" TEXT,
    "protocolId" TEXT,
    "calibrationProfileId" TEXT,
    "skuId" TEXT,
    "skuCodeSnapshot" TEXT,
    "actionLabel" TEXT NOT NULL,
    "correctedActionLabel" TEXT,
    "reviewVerdict" TEXT NOT NULL,
    "reviewSource" TEXT NOT NULL,
    "confidenceBucket" TEXT,
    "lightingBucket" TEXT,
    "occlusionBucket" TEXT,
    "calibrationZoneLabel" TEXT,
    "scenarioTypeSnapshot" TEXT,
    "split" "CvDatasetSplit",
    "eligibility" "CvDatasetEligibility" NOT NULL,
    "exclusionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CvDatasetCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CvDatasetImprovementRun_id_tenantId_key" ON "CvDatasetImprovementRun"("id", "tenantId");
CREATE INDEX "CvDatasetImprovementRun_tenantId_createdAt_idx" ON "CvDatasetImprovementRun"("tenantId", "createdAt" DESC);
CREATE INDEX "CvDatasetImprovementRun_tenantId_status_idx" ON "CvDatasetImprovementRun"("tenantId", "status");
CREATE UNIQUE INDEX "CvDatasetCandidate_id_tenantId_key" ON "CvDatasetCandidate"("id", "tenantId");
CREATE UNIQUE INDEX "CvDatasetCandidate_tenantId_runId_sourceType_sourceId_key" ON "CvDatasetCandidate"("tenantId", "runId", "sourceType", "sourceId");
CREATE INDEX "CvDatasetCandidate_tenantId_runId_eligibility_idx" ON "CvDatasetCandidate"("tenantId", "runId", "eligibility");

-- AddForeignKey
ALTER TABLE "CvDatasetImprovementRun" ADD CONSTRAINT "CvDatasetImprovementRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Same-tenant composite relations (AGENTS.md: tenancy / Codex P1): the
-- FK itself carries the tenant, so a malformed row can never resolve
-- another tenant's evaluation run, protocol, or calibration profile.
ALTER TABLE "CvDatasetImprovementRun" ADD CONSTRAINT "CvDatasetImprovementRun_sourceEvaluationRunId_tenantId_fkey" FOREIGN KEY ("sourceEvaluationRunId", "tenantId") REFERENCES "PilotEvaluationRun"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvDatasetImprovementRun" ADD CONSTRAINT "CvDatasetImprovementRun_sourceTestProtocolId_tenantId_fkey" FOREIGN KEY ("sourceTestProtocolId", "tenantId") REFERENCES "CvTestProtocol"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvDatasetImprovementRun" ADD CONSTRAINT "CvDatasetImprovementRun_sourceCalibrationProfileId_tenant_fkey" FOREIGN KEY ("sourceCalibrationProfileId", "tenantId") REFERENCES "CameraCalibrationProfile"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvDatasetCandidate" ADD CONSTRAINT "CvDatasetCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvDatasetCandidate" ADD CONSTRAINT "CvDatasetCandidate_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "CvDatasetImprovementRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
