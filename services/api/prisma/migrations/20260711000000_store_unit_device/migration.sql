-- Phase 4: stores (Location, already present), autonomous retail units,
-- devices, and the edge-registration foundation.

-- New audit actions for device registration and heartbeats.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "AuditAction" ADD VALUE 'REGISTER';
ALTER TYPE "AuditAction" ADD VALUE 'HEARTBEAT';

-- CreateEnum
CREATE TYPE "RetailUnitType" AS ENUM ('SMART_FRIDGE', 'SMART_SHELF', 'KIOSK', 'VENDING_MACHINE', 'MICRO_MARKET', 'SMART_GATE', 'OTHER');

-- CreateEnum
CREATE TYPE "RetailUnitStatus" AS ENUM ('DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED', 'RETIRED');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('CAMERA', 'DOOR_LOCK', 'SHELF_SENSOR', 'WEIGHT_SENSOR', 'PAYMENT_TERMINAL', 'EDGE_GATEWAY', 'TEMPERATURE_SENSOR', 'OTHER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PROVISIONED', 'ONLINE', 'OFFLINE', 'MAINTENANCE', 'DISABLED', 'RETIRED');

-- CreateTable
CREATE TABLE "RetailUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RetailUnitType" NOT NULL,
    "status" "RetailUnitStatus" NOT NULL DEFAULT 'DRAFT',
    "placement" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetailUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PROVISIONED',
    "serialNumber" TEXT NOT NULL,
    "metadata" JSONB,
    "firmwareVersion" TEXT,
    "softwareVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "registrationTokenHash" TEXT,
    "registrationTokenExpiresAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetailUnit_tenantId_code_key" ON "RetailUnit"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RetailUnit_id_tenantId_key" ON "RetailUnit"("id", "tenantId");

-- CreateIndex
CREATE INDEX "RetailUnit_tenantId_locationId_idx" ON "RetailUnit"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "RetailUnit_tenantId_status_idx" ON "RetailUnit"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RetailUnit_tenantId_type_idx" ON "RetailUnit"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Device_registrationTokenHash_key" ON "Device"("registrationTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_serialNumber_key" ON "Device"("tenantId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Device_id_tenantId_key" ON "Device"("id", "tenantId");

-- CreateIndex
CREATE INDEX "Device_tenantId_unitId_idx" ON "Device"("tenantId", "unitId");

-- CreateIndex
CREATE INDEX "Device_tenantId_status_idx" ON "Device"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Device_tenantId_type_idx" ON "Device"("tenantId", "type");

-- CreateIndex
CREATE INDEX "Device_tenantId_lastSeenAt_idx" ON "Device"("tenantId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "RetailUnit" ADD CONSTRAINT "RetailUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetailUnit" ADD CONSTRAINT "RetailUnit_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RetailUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
-- Documented in services/api/README.md; covered by tests. Do not drop when
-- regenerating migrations.
------------------------------------------------------------------------------

-- Cross-tenant reference integrity at the database level (same pattern as
-- Phase 3): a unit can never live in another tenant's store, and a device
-- can never be attached to another tenant's unit, even if an unscoped id
-- ever slipped through application code.
ALTER TABLE "RetailUnit" ADD CONSTRAINT "RetailUnit_location_same_tenant_fkey"
  FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_unit_same_tenant_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "RetailUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
