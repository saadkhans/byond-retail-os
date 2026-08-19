-- Phase 16 — live CV test protocol (SHADOW ONLY): organizational test
-- protocols + scripted scenarios around the Phase 15 evaluation loop.
-- No CV decision reads these tables; nothing here touches checkout,
-- order, payment, or inventory state.

-- CreateEnum
CREATE TYPE "CvTestProtocolStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "CvTestScenarioType" AS ENUM ('SINGLE_PICKUP', 'SINGLE_RETURN', 'FALSE_TOUCH_NO_PRODUCT_MOVED', 'MISSED_PICKUP', 'MISSED_RETURN', 'TWO_PRODUCTS_VISIBLE_ONE_PICKED', 'SIMILAR_SKU_CONFUSION', 'MULTI_QUANTITY_PICKUP', 'HAND_OCCLUSION', 'FAST_PICKUP', 'SLOW_PICKUP', 'LOW_LIGHT', 'BAD_ANGLE', 'EMPTY_SHELF', 'UNKNOWN_PRODUCT');
CREATE TYPE "CvTestScenarioResult" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');

-- CreateTable
CREATE TABLE "CvTestProtocol" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "locationId" TEXT,
    "cameraSourceId" TEXT,
    "evaluationRunId" TEXT,
    "fastModeExpected" BOOLEAN,
    "status" "CvTestProtocolStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CvTestProtocol_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CvTestProtocolScenario" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "scenarioType" "CvTestScenarioType" NOT NULL,
    "expectedAction" "PilotExpectedAction" NOT NULL,
    "expectedProductId" TEXT,
    "expectedSku" TEXT,
    "expectedQuantity" INTEGER,
    "notes" TEXT,
    "liveSessionId" TEXT,
    "result" "CvTestScenarioResult",
    "resultNotes" TEXT,
    "resultById" TEXT,
    "resultAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CvTestProtocolScenario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CvTestProtocol_id_tenantId_key" ON "CvTestProtocol"("id", "tenantId");
CREATE INDEX "CvTestProtocol_tenantId_createdAt_idx" ON "CvTestProtocol"("tenantId", "createdAt" DESC);
CREATE UNIQUE INDEX "CvTestProtocolScenario_id_tenantId_key" ON "CvTestProtocolScenario"("id", "tenantId");
CREATE INDEX "CvTestProtocolScenario_tenantId_protocolId_createdAt_idx" ON "CvTestProtocolScenario"("tenantId", "protocolId", "createdAt");

-- AddForeignKey
ALTER TABLE "CvTestProtocol" ADD CONSTRAINT "CvTestProtocol_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocol" ADD CONSTRAINT "CvTestProtocol_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocol" ADD CONSTRAINT "CvTestProtocol_cameraSourceId_fkey" FOREIGN KEY ("cameraSourceId") REFERENCES "CameraSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocol" ADD CONSTRAINT "CvTestProtocol_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "PilotEvaluationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocolScenario" ADD CONSTRAINT "CvTestProtocolScenario_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocolScenario" ADD CONSTRAINT "CvTestProtocolScenario_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "CvTestProtocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocolScenario" ADD CONSTRAINT "CvTestProtocolScenario_expectedProductId_fkey" FOREIGN KEY ("expectedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocolScenario" ADD CONSTRAINT "CvTestProtocolScenario_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveCameraSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same-tenant composite FKs (AGENTS.md: tenancy).
ALTER TABLE "CvTestProtocolScenario" ADD CONSTRAINT "CvTestProtocolScenario_protocol_same_tenant_fkey" FOREIGN KEY ("protocolId", "tenantId") REFERENCES "CvTestProtocol"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocolScenario" ADD CONSTRAINT "CvTestProtocolScenario_live_same_tenant_fkey" FOREIGN KEY ("liveSessionId", "tenantId") REFERENCES "LiveCameraSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocol" ADD CONSTRAINT "CvTestProtocol_run_same_tenant_fkey" FOREIGN KEY ("evaluationRunId", "tenantId") REFERENCES "PilotEvaluationRun"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CvTestProtocol" ADD CONSTRAINT "CvTestProtocol_source_same_tenant_fkey" FOREIGN KEY ("cameraSourceId", "tenantId") REFERENCES "CameraSource"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
