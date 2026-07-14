import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the hand-written database hardening in migration SQL. These guarantees
 * live OUTSIDE what the Prisma schema can express, so a regenerated migration
 * could silently drop them — this spec fails if they disappear.
 */
describe('catalog & inventory migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260708000000_catalog_inventory',
      'migration.sql',
    ),
    'utf8',
  );

  it('makes the inventory ledger append-only at the database level', () => {
    expect(sql).toContain('CREATE FUNCTION prevent_inventory_movement_mutation()');
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON "InventoryMovement"',
    );
    expect(sql).toContain('BEFORE TRUNCATE ON "InventoryMovement"');
  });

  it('blocks negative stock and zero-delta movements with CHECK constraints', () => {
    expect(sql).toContain('CHECK ("quantity" >= 0)');
    expect(sql).toContain('CHECK ("quantityDelta" <> 0)');
    expect(sql).toContain('CHECK ("quantityAfter" >= 0)');
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'ProductCategory_parent_same_tenant_fkey',
      'Product_category_same_tenant_fkey',
      'Product_brand_same_tenant_fkey',
      'ProductBarcode_product_same_tenant_fkey',
      'InventoryLevel_location_same_tenant_fkey',
      'InventoryLevel_product_same_tenant_fkey',
      'InventoryMovement_location_same_tenant_fkey',
      'InventoryMovement_product_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('never cascades deletes into catalog or inventory tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('checkout & orders migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260713000000_checkout_session_orders',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds the SALE ledger type and lifecycle audit actions', () => {
    expect(sql).toContain(`ALTER TYPE "InventoryMovementType" ADD VALUE 'SALE'`);
    expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE 'COMPLETE'`);
    expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE 'CANCEL'`);
    expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE 'EXPIRE'`);
  });

  it('blocks non-positive line quantities and empty orders with CHECK constraints', () => {
    expect(sql).toContain('CheckoutSessionLine_quantity_positive_check');
    expect(sql).toContain('OrderLine_quantity_positive_check');
    expect(sql).toContain('Order_totalQuantity_positive_check');
    expect(sql).toContain('CHECK ("quantity" >= 1)');
    expect(sql).toContain('CHECK ("totalQuantity" >= 1)');
  });

  it('constrains evidence scores to normalized [0, 1] confidences', () => {
    for (const constraint of [
      'CheckoutSession_evidenceScore_range_check',
      'CheckoutSessionLine_evidenceScore_range_check',
      'Order_evidenceScore_range_check',
      'OrderLine_evidenceScore_range_check',
    ]) {
      expect(sql).toContain(constraint);
    }
    expect(sql).toContain(
      '"evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1)',
    );
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'CheckoutSession_location_same_tenant_fkey',
      'CheckoutSession_unit_same_tenant_fkey',
      'CheckoutSession_device_same_tenant_fkey',
      'CheckoutSessionLine_session_same_tenant_fkey',
      'CheckoutSessionLine_product_same_tenant_fkey',
      'Order_session_same_tenant_fkey',
      'Order_location_same_tenant_fkey',
      'Order_unit_same_tenant_fkey',
      'OrderLine_order_same_tenant_fkey',
      'OrderLine_product_same_tenant_fkey',
      'OrderLine_sessionLine_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('keeps order numbers and idempotency keys unique per tenant', () => {
    expect(sql).toContain('Order_tenantId_orderNumber_key');
    expect(sql).toContain('Order_tenantId_idempotencyKey_key');
    expect(sql).toContain('CheckoutSession_tenantId_idempotencyKey_key');
    expect(sql).toContain('CheckoutSessionLine_tenantId_idempotencyKey_key');
  });

  it('never cascades deletes into checkout or order tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('checkout module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260713000001_checkout_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('is idempotent and never overwrites a tenant admin choice', () => {
    expect(sql).toContain('ON CONFLICT ("code") DO NOTHING');
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
  });

  it('enables checkout for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':checkout')`);
    expect(sql).toContain(`WHERE pm."code" = 'checkout'`);
  });
});
