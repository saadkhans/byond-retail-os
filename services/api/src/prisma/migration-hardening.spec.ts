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
