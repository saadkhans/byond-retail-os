-- Phase 26 — the store flow.
--
-- Adds shopper identity, single-use store entry tokens, the versioned
-- autonomy policy that governs how much a store may do without a human, the
-- projection ledger that makes the CV -> basket bridge idempotent, and the
-- commerce links a customer journey was missing (shopper, checkout session,
-- order, settlement status).
--
-- Nothing here changes existing behaviour: every new column on
-- CustomerJourney is nullable or defaults to NOT_STARTED, and the default
-- autonomy level is SHADOW.

-- CreateEnum
CREATE TYPE "ShopperStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "StoreEntryTokenStatus" AS ENUM ('ISSUED', 'REDEEMED', 'REVOKED');

-- CreateEnum
CREATE TYPE "StoreFlowAutonomyLevel" AS ENUM ('SHADOW', 'PROPOSE', 'AUTO_APPLY');

-- CreateEnum
CREATE TYPE "StoreFlowProjectionOutcome" AS ENUM ('SKIPPED', 'PROPOSED', 'AUTO_APPLIED', 'REVIEW_REQUIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StoreFlowSettlementStatus" AS ENUM ('NOT_STARTED', 'BLOCKED_ON_REVIEW', 'ORDER_CREATED', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "CustomerJourney" ADD COLUMN     "checkoutSessionId" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "settlementStatus" "StoreFlowSettlementStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "shopperId" TEXT;

-- CreateTable
CREATE TABLE "Shopper" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "status" "ShopperStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shopper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreEntryToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "shopperId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" "StoreEntryTokenStatus" NOT NULL DEFAULT 'ISSUED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedJourneyId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreEntryToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreFlowPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "activeVersionId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreFlowPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreFlowPolicyVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "autonomyLevel" "StoreFlowAutonomyLevel" NOT NULL DEFAULT 'SHADOW',
    "autoApplyMinConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "requireInventoryValidation" BOOLEAN NOT NULL DEFAULT true,
    "settleOnExit" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreFlowPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreFlowProjection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "journeyEventId" TEXT NOT NULL,
    "outcome" "StoreFlowProjectionOutcome" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "visionEventId" TEXT,
    "autonomyLevel" "StoreFlowAutonomyLevel" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreFlowProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shopper_tenantId_status_createdAt_idx" ON "Shopper"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Shopper_tenantId_userId_idx" ON "Shopper"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Shopper_id_tenantId_key" ON "Shopper"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreEntryToken_redeemedJourneyId_key" ON "StoreEntryToken"("redeemedJourneyId");

-- CreateIndex
CREATE INDEX "StoreEntryToken_tenantId_status_expiresAt_idx" ON "StoreEntryToken"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "StoreEntryToken_tenantId_locationId_unitId_idx" ON "StoreEntryToken"("tenantId", "locationId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreEntryToken_id_tenantId_key" ON "StoreEntryToken"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreEntryToken_tenantId_tokenHash_key" ON "StoreEntryToken"("tenantId", "tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowPolicy_activeVersionId_key" ON "StoreFlowPolicy"("activeVersionId");

-- CreateIndex
CREATE INDEX "StoreFlowPolicy_tenantId_locationId_idx" ON "StoreFlowPolicy"("tenantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowPolicy_id_tenantId_key" ON "StoreFlowPolicy"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowPolicy_tenantId_locationId_key" ON "StoreFlowPolicy"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "StoreFlowPolicyVersion_tenantId_policyId_versionNumber_idx" ON "StoreFlowPolicyVersion"("tenantId", "policyId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowPolicyVersion_id_tenantId_key" ON "StoreFlowPolicyVersion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowPolicyVersion_policyId_versionNumber_key" ON "StoreFlowPolicyVersion"("policyId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowProjection_visionEventId_key" ON "StoreFlowProjection"("visionEventId");

-- CreateIndex
CREATE INDEX "StoreFlowProjection_tenantId_journeyId_createdAt_idx" ON "StoreFlowProjection"("tenantId", "journeyId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreFlowProjection_tenantId_outcome_idx" ON "StoreFlowProjection"("tenantId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowProjection_id_tenantId_key" ON "StoreFlowProjection"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreFlowProjection_tenantId_journeyEventId_key" ON "StoreFlowProjection"("tenantId", "journeyEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerJourney_checkoutSessionId_key" ON "CustomerJourney"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerJourney_orderId_key" ON "CustomerJourney"("orderId");

-- CreateIndex
CREATE INDEX "CustomerJourney_tenantId_shopperId_startedAt_idx" ON "CustomerJourney"("tenantId", "shopperId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "CustomerJourney_tenantId_settlementStatus_idx" ON "CustomerJourney"("tenantId", "settlementStatus");

-- AddForeignKey
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerJourney" ADD CONSTRAINT "CustomerJourney_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shopper" ADD CONSTRAINT "Shopper_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shopper" ADD CONSTRAINT "Shopper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreEntryToken" ADD CONSTRAINT "StoreEntryToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreEntryToken" ADD CONSTRAINT "StoreEntryToken_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreEntryToken" ADD CONSTRAINT "StoreEntryToken_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreEntryToken" ADD CONSTRAINT "StoreEntryToken_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreEntryToken" ADD CONSTRAINT "StoreEntryToken_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreEntryToken" ADD CONSTRAINT "StoreEntryToken_redeemedJourneyId_fkey" FOREIGN KEY ("redeemedJourneyId") REFERENCES "CustomerJourney"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicy" ADD CONSTRAINT "StoreFlowPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicy" ADD CONSTRAINT "StoreFlowPolicy_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicy" ADD CONSTRAINT "StoreFlowPolicy_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicy" ADD CONSTRAINT "StoreFlowPolicy_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "StoreFlowPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicyVersion" ADD CONSTRAINT "StoreFlowPolicyVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicyVersion" ADD CONSTRAINT "StoreFlowPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "StoreFlowPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowPolicyVersion" ADD CONSTRAINT "StoreFlowPolicyVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowProjection" ADD CONSTRAINT "StoreFlowProjection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowProjection" ADD CONSTRAINT "StoreFlowProjection_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "CustomerJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowProjection" ADD CONSTRAINT "StoreFlowProjection_journeyEventId_fkey" FOREIGN KEY ("journeyEventId") REFERENCES "CustomerJourneyEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreFlowProjection" ADD CONSTRAINT "StoreFlowProjection_visionEventId_fkey" FOREIGN KEY ("visionEventId") REFERENCES "VisionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written hardening the Prisma schema cannot express.
-- ---------------------------------------------------------------------------

-- 1. SAME-TENANT COMPOSITE FOREIGN KEYS.
--    Every relation above is keyed by id alone, so a known foreign id would
--    otherwise link rows across tenants. These composite keys make that
--    structurally impossible at the database, independent of application code
--    (same pattern as 20260811110000_cv_same_tenant_fks).

ALTER TABLE "CustomerJourney"
  ADD CONSTRAINT "CustomerJourney_shopper_same_tenant_fkey"
  FOREIGN KEY ("shopperId", "tenantId")
  REFERENCES "Shopper"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerJourney"
  ADD CONSTRAINT "CustomerJourney_session_same_tenant_fkey"
  FOREIGN KEY ("checkoutSessionId", "tenantId")
  REFERENCES "CheckoutSession"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerJourney"
  ADD CONSTRAINT "CustomerJourney_order_same_tenant_fkey"
  FOREIGN KEY ("orderId", "tenantId")
  REFERENCES "Order"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId")
  REFERENCES "Location"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId")
  REFERENCES "RetailUnit"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_shopper_same_tenant_fkey"
  FOREIGN KEY ("shopperId", "tenantId")
  REFERENCES "Shopper"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_journey_same_tenant_fkey"
  FOREIGN KEY ("redeemedJourneyId", "tenantId")
  REFERENCES "CustomerJourney"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreFlowPolicy"
  ADD CONSTRAINT "StoreFlowPolicy_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId")
  REFERENCES "Location"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreFlowPolicy"
  ADD CONSTRAINT "StoreFlowPolicy_active_version_same_tenant_fkey"
  FOREIGN KEY ("activeVersionId", "tenantId")
  REFERENCES "StoreFlowPolicyVersion"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreFlowPolicyVersion"
  ADD CONSTRAINT "StoreFlowPolicyVersion_policy_same_tenant_fkey"
  FOREIGN KEY ("policyId", "tenantId")
  REFERENCES "StoreFlowPolicy"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreFlowProjection"
  ADD CONSTRAINT "StoreFlowProjection_journey_same_tenant_fkey"
  FOREIGN KEY ("journeyId", "tenantId")
  REFERENCES "CustomerJourney"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreFlowProjection"
  ADD CONSTRAINT "StoreFlowProjection_event_same_tenant_fkey"
  FOREIGN KEY ("journeyEventId", "tenantId")
  REFERENCES "CustomerJourneyEvent"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreFlowProjection"
  ADD CONSTRAINT "StoreFlowProjection_vision_event_same_tenant_fkey"
  FOREIGN KEY ("visionEventId", "tenantId")
  REFERENCES "VisionEvent"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. ONE TENANT-WIDE POLICY PER TENANT.
--    Postgres treats NULLs as distinct in a unique index, so the
--    (tenantId, locationId) unique above does NOT stop a tenant collecting
--    several tenant-wide default rows. Prisma cannot express a partial index.
CREATE UNIQUE INDEX "StoreFlowPolicy_tenant_default_key"
  ON "StoreFlowPolicy"("tenantId")
  WHERE "locationId" IS NULL;

-- 3. ENTRY TOKEN INVARIANTS.
--    The stored value must be a SHA-256 digest, never a usable secret: 64
--    lowercase hex characters and nothing else.
ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_token_hash_is_sha256"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

--    Short-TTL by construction: an entry credential can never be issued
--    already-expired, and the API caps the window further.
ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_expiry_after_issue"
  CHECK ("expiresAt" > "createdAt");

--    Status and its evidence move together, so a REDEEMED row can never
--    exist without the journey it opened.
ALTER TABLE "StoreEntryToken"
  ADD CONSTRAINT "StoreEntryToken_status_evidence"
  CHECK (
    (
      "status" = 'ISSUED'
      AND "redeemedAt" IS NULL
      AND "redeemedJourneyId" IS NULL
      AND "revokedAt" IS NULL
    )
    OR (
      "status" = 'REDEEMED'
      AND "redeemedAt" IS NOT NULL
      AND "redeemedJourneyId" IS NOT NULL
      AND "revokedAt" IS NULL
    )
    OR (
      "status" = 'REVOKED'
      AND "revokedAt" IS NOT NULL
      AND "redeemedAt" IS NULL
      AND "redeemedJourneyId" IS NULL
    )
  );

-- 4. POLICY VERSION INVARIANTS.
ALTER TABLE "StoreFlowPolicyVersion"
  ADD CONSTRAINT "StoreFlowPolicyVersion_version_number_positive"
  CHECK ("versionNumber" >= 1);

--    The threshold is compared against an uncalibrated ranking score in
--    [0, 1]; a value outside it would silently disable or force automation.
ALTER TABLE "StoreFlowPolicyVersion"
  ADD CONSTRAINT "StoreFlowPolicyVersion_confidence_in_range"
  CHECK ("autoApplyMinConfidence" >= 0 AND "autoApplyMinConfidence" <= 1);

-- 5. PROJECTION INVARIANTS.
--    An outcome that claims a vision event must carry one, and one that
--    claims none must not — so the audit trail cannot lie about what the
--    bridge did.
ALTER TABLE "StoreFlowProjection"
  ADD CONSTRAINT "StoreFlowProjection_outcome_evidence"
  CHECK (
    (
      "outcome" IN ('PROPOSED', 'AUTO_APPLIED', 'REJECTED')
      AND "visionEventId" IS NOT NULL
    )
    OR (
      "outcome" IN ('SKIPPED', 'REVIEW_REQUIRED')
    )
  );

ALTER TABLE "StoreFlowProjection"
  ADD CONSTRAINT "StoreFlowProjection_confidence_in_range"
  CHECK (
    "confidence" IS NULL
    OR ("confidence" >= 0 AND "confidence" <= 1)
  );

-- 6. JOURNEY SETTLEMENT INVARIANTS.
--    A journey that reached ORDER_CREATED or PAID must carry the order it
--    became; settlement state and its evidence never drift apart.
ALTER TABLE "CustomerJourney"
  ADD CONSTRAINT "CustomerJourney_settlement_evidence"
  CHECK (
    "settlementStatus" NOT IN ('ORDER_CREATED', 'PAID')
    OR "orderId" IS NOT NULL
  );
