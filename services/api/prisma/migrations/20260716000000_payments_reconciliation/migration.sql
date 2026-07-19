-- Phase 6: payment authorization, payment abstraction & reconciliation
-- foundation.
--
-- NO live payment gateway in this phase: authorization and capture are
-- SIMULATED through the internal state machine. Every "provider" reference is
-- an OPAQUE, normalized identifier a future gateway adapter will populate.
--
-- SECURITY INVARIANT (AGENTS.md): no raw card data or secrets are EVER stored.
-- These tables carry only opaque provider references and SAFE card metadata
-- (brand, last4, expiry month/year, wallet). Raw PAN/CVV/PIN/track data,
-- provider secret keys, bearer tokens, API keys, and raw webhook
-- secrets/payloads never reach any column here — the application additionally
-- screens every persisted free-form string with common/sensitive-keys.

-- New payment-lifecycle audit actions. Intent creation reuses CREATE; these
-- cover the transitions with no generic equivalent.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long
-- as the new value is not used within the same transaction — it is not here.)
ALTER TYPE "AuditAction" ADD VALUE 'AUTHORIZE';
ALTER TYPE "AuditAction" ADD VALUE 'CAPTURE';
ALTER TYPE "AuditAction" ADD VALUE 'VOID';
ALTER TYPE "AuditAction" ADD VALUE 'FAIL';
ALTER TYPE "AuditAction" ADD VALUE 'RECONCILE';

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('SIMULATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'REQUIRES_AUTHORIZATION', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'FAILED', 'CANCELLED', 'VOIDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'AUTHORIZED', 'PAID', 'PAYMENT_FAILED', 'VOIDED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentAuthorizationStatus" AS ENUM ('AUTHORIZED', 'VOIDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentCaptureStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentEventType" AS ENUM ('AUTHORIZATION_SUCCEEDED', 'AUTHORIZATION_FAILED', 'CAPTURE_SUCCEEDED', 'CAPTURE_FAILED', 'PAYMENT_CANCELLED', 'PAYMENT_VOIDED', 'PAYMENT_EXPIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PaymentEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'MATCHED', 'MISMATCH', 'RECONCILED', 'FAILED');

-- AlterTable — Order gains a payment-status projection. Existing rows default
-- to UNPAID; nothing marks an order paid except a CAPTURED payment intent.
ALTER TABLE "Order" ADD COLUMN "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID';
ALTER TABLE "Order" ADD COLUMN "paidAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT,
    "checkoutSessionId" TEXT,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'SIMULATED',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "amountMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "capturedAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "providerCustomerRef" TEXT,
    "instrumentBrand" TEXT,
    "instrumentLast4" TEXT,
    "instrumentExpiryMonth" INTEGER,
    "instrumentExpiryYear" INTEGER,
    "instrumentWallet" TEXT,
    "description" TEXT,
    "failureReason" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAuthorization" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "status" "PaymentAuthorizationStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "amountMinor" INTEGER NOT NULL,
    "providerRef" TEXT,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCapture" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "status" "PaymentCaptureStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "amountMinor" INTEGER NOT NULL,
    "providerRef" TEXT,
    "capturedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentCapture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentId" TEXT,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'SIMULATED',
    "providerEventId" TEXT NOT NULL,
    "eventType" "PaymentEventType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "PaymentEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "providerRef" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReconciliationRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentId" TEXT,
    "captureId" TEXT,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'SIMULATED',
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "expectedAmountMinor" INTEGER,
    "reportedAmountMinor" INTEGER,
    "currencyCode" TEXT,
    "notes" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_id_tenantId_key" ON "PaymentIntent"("id", "tenantId");
CREATE UNIQUE INDEX "PaymentIntent_tenantId_idempotencyKey_key" ON "PaymentIntent"("tenantId", "idempotencyKey");
CREATE INDEX "PaymentIntent_tenantId_status_createdAt_id_idx" ON "PaymentIntent"("tenantId", "status", "createdAt", "id");
CREATE INDEX "PaymentIntent_tenantId_orderId_idx" ON "PaymentIntent"("tenantId", "orderId");
CREATE INDEX "PaymentIntent_tenantId_checkoutSessionId_idx" ON "PaymentIntent"("tenantId", "checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAuthorization_id_tenantId_key" ON "PaymentAuthorization"("id", "tenantId");
CREATE UNIQUE INDEX "PaymentAuthorization_tenantId_idempotencyKey_key" ON "PaymentAuthorization"("tenantId", "idempotencyKey");
CREATE INDEX "PaymentAuthorization_tenantId_intentId_createdAt_id_idx" ON "PaymentAuthorization"("tenantId", "intentId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCapture_id_tenantId_key" ON "PaymentCapture"("id", "tenantId");
CREATE UNIQUE INDEX "PaymentCapture_tenantId_idempotencyKey_key" ON "PaymentCapture"("tenantId", "idempotencyKey");
CREATE INDEX "PaymentCapture_tenantId_intentId_createdAt_id_idx" ON "PaymentCapture"("tenantId", "intentId", "createdAt", "id");
CREATE INDEX "PaymentCapture_tenantId_status_createdAt_id_idx" ON "PaymentCapture"("tenantId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_id_tenantId_key" ON "PaymentEvent"("id", "tenantId");
CREATE UNIQUE INDEX "PaymentEvent_tenantId_provider_providerEventId_key" ON "PaymentEvent"("tenantId", "provider", "providerEventId");
CREATE UNIQUE INDEX "PaymentEvent_tenantId_idempotencyKey_key" ON "PaymentEvent"("tenantId", "idempotencyKey");
CREATE INDEX "PaymentEvent_tenantId_status_receivedAt_id_idx" ON "PaymentEvent"("tenantId", "status", "receivedAt", "id");
CREATE INDEX "PaymentEvent_tenantId_intentId_idx" ON "PaymentEvent"("tenantId", "intentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReconciliationRecord_id_tenantId_key" ON "PaymentReconciliationRecord"("id", "tenantId");
CREATE INDEX "PaymentReconciliationRecord_tenantId_status_createdAt_id_idx" ON "PaymentReconciliationRecord"("tenantId", "status", "createdAt", "id");
CREATE INDEX "PaymentReconciliationRecord_tenantId_intentId_idx" ON "PaymentReconciliationRecord"("tenantId", "intentId");

-- AddForeignKey (standard @relation FKs)
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentCapture" ADD CONSTRAINT "PaymentCapture_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentCapture" ADD CONSTRAINT "PaymentCapture_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentCapture" ADD CONSTRAINT "PaymentCapture_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "PaymentCapture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- 1. Money is non-negative minor units, and a simulated capture can never
--    exceed the authorized amount. The application validates first; these
--    CHECKs backstop any future code path that forgets to.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_amountMinor_nonneg_check"
  CHECK ("amountMinor" >= 0);
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_capturedAmount_range_check"
  CHECK ("capturedAmountMinor" >= 0 AND "capturedAmountMinor" <= "amountMinor");
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_amountMinor_nonneg_check"
  CHECK ("amountMinor" >= 0);
ALTER TABLE "PaymentCapture" ADD CONSTRAINT "PaymentCapture_amountMinor_nonneg_check"
  CHECK ("amountMinor" >= 0);
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_amounts_nonneg_check"
  CHECK (
    ("expectedAmountMinor" IS NULL OR "expectedAmountMinor" >= 0)
    AND ("reportedAmountMinor" IS NULL OR "reportedAmountMinor" >= 0)
  );

-- 2. SAFE card metadata only. last4 is EXACTLY four digits (never a full PAN),
--    and expiry month/year stay in sane ranges. A raw card number can never
--    masquerade as "last4" past this constraint.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_instrumentLast4_format_check"
  CHECK ("instrumentLast4" IS NULL OR "instrumentLast4" ~ '^[0-9]{4}$');
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_instrumentExpiryMonth_range_check"
  CHECK ("instrumentExpiryMonth" IS NULL OR ("instrumentExpiryMonth" >= 1 AND "instrumentExpiryMonth" <= 12));
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_instrumentExpiryYear_range_check"
  CHECK ("instrumentExpiryYear" IS NULL OR ("instrumentExpiryYear" >= 2000 AND "instrumentExpiryYear" <= 2100));

-- 3. Cross-tenant reference integrity at the database level (same pattern as
--    Phases 3/4/5): a payment intent can never reference another tenant's
--    order or checkout session; authorizations/captures/events/reconciliation
--    records can never reference another tenant's intent; a reconciliation
--    record can never reference another tenant's capture — even if an unscoped
--    id ever slipped through application code. (MATCH SIMPLE skips the check
--    when a nullable column is NULL — exactly what optional references need.)
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_order_same_tenant_fkey"
  FOREIGN KEY ("orderId", "tenantId") REFERENCES "Order"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_session_same_tenant_fkey"
  FOREIGN KEY ("checkoutSessionId", "tenantId") REFERENCES "CheckoutSession"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAuthorization" ADD CONSTRAINT "PaymentAuthorization_intent_same_tenant_fkey"
  FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentCapture" ADD CONSTRAINT "PaymentCapture_intent_same_tenant_fkey"
  FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_intent_same_tenant_fkey"
  FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_intent_same_tenant_fkey"
  FOREIGN KEY ("intentId", "tenantId") REFERENCES "PaymentIntent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReconciliationRecord" ADD CONSTRAINT "PaymentReconciliationRecord_capture_same_tenant_fkey"
  FOREIGN KEY ("captureId", "tenantId") REFERENCES "PaymentCapture"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
