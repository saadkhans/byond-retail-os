import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The reverse flow is the one module that can put stock BACK and send money
 * BACK. Both directions are exactly as dangerous as the forward ones, so the
 * guarantees are restated here as a grep guard over the whole directory —
 * a reviewer reading one file cannot see what a sibling file does.
 *
 * Four things are enforced:
 *
 *   1. Stock changes ONLY through the append-only ledger. No file here may
 *      write an InventoryLevel, in any form.
 *   2. Money moves ONLY through the payments abstraction. No file here may
 *      write a payment table; this module asks PaymentsService instead.
 *   3. Every destructive write carries the tenant IN its predicate.
 *   4. Nothing here accepts, stores or names raw card data.
 *
 * If one of these fails, the fix is the code — never this file.
 */
describe('returns boundary', () => {
  const root = join(__dirname);

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
    });

  const files = sourceFiles(root);

  it('finds the module it is guarding', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never writes a stock level directly', () => {
    // Reading the projection is legitimate (a cycle count compares against
    // it). Writing it is not: a stock level may only move because a ledger
    // movement moved it.
    const forbidden =
      /\binventoryLevel\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} calls ${match[0]} — stock changes only through the ` +
              'append-only ledger (InventoryRepository.applyMovement)'
          : null,
      ).toBeNull();
    }
  });

  it('never writes an inventory movement except through applyMovement', () => {
    // Even the LEDGER must not be written by hand here: applyMovement is what
    // enforces the advisory lock, the existence checks, the conditional
    // increment and the quantityAfter snapshot.
    const forbidden =
      /\binventoryMovement\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} calls ${match[0]} — append movements through ` +
              'InventoryRepository.applyMovement, never directly'
          : null,
      ).toBeNull();
    }
  });

  it('actually goes through applyMovement for every stock path', () => {
    // The negative guards above are only meaningful if the positive path is
    // present: all four stock paths (return, cancellation reversal, count
    // variance, shrink) must reach the ledger the same way.
    const callers = files.filter((file) =>
      readFileSync(file, 'utf8').includes('inventoryRepository.applyMovement('),
    );
    expect(callers.map((file) => file.split(/[\\/]/).pop()).sort()).toEqual([
      'cycle-count.repository.ts',
      'returns.repository.ts',
      'shrink.repository.ts',
    ]);
  });

  it('never writes a payment table itself', () => {
    const forbidden =
      /\b(paymentIntent|paymentCapture|paymentAuthorization|paymentRefund)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} calls ${match[0]} — money moves only through ` +
              'PaymentsService, which owns the provider-neutral abstraction'
          : null,
      ).toBeNull();
    }
  });

  it('carries the tenant in every destructive write predicate', () => {
    // The bug this pins was found five times in one review round: a write
    // that relies on a prior tenant-scoped lookup instead of naming the
    // tenant in its own predicate. Every update/delete here must use the
    // id_tenantId composite key, a tenant-leading composite key, or an
    // explicit tenantId in a `where`.
    const writeCall =
      /\b\w+\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\s*\(\s*\{([\s\S]{0,400}?)\bdata:/g;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(writeCall)) {
        const predicate = match[2];
        const scoped =
          predicate.includes('id_tenantId') ||
          predicate.includes('tenantId_') ||
          /\btenantId\s*:/.test(predicate);
        expect(
          scoped
            ? null
            : `${file} performs a ${match[1]} whose where clause does not ` +
                `name the tenant: ${predicate.trim().slice(0, 120)}`,
        ).toBeNull();
      }
    }
  });

  it('screens every operator free-text field before it is written', () => {
    // reason / note / reference all land verbatim in an append-only record
    // AND in AuditLog.reason, which redaction does not cover.
    const services = files.filter((file) => file.endsWith('.service.ts'));
    expect(services.length).toBe(3);
    for (const file of services) {
      expect(readFileSync(file, 'utf8')).toContain(
        'assertSafeReverseFlowText',
      );
    }
  });

  it('names no raw card data anywhere', () => {
    const forbidden =
      /\b(cardNumber|primaryAccountNumber|cvv|cvc|pinBlock|magneticTrack)\b/i;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} mentions ${match[0]} — no raw card data, ever` : null,
      ).toBeNull();
    }
  });

  it('leaves every pre-existing shadow guard in place', () => {
    // This phase must not have been made to pass by deleting the tests that
    // keep the observation-side modules inert.
    const modulesWithGuards = [
      'journey',
      'pickup-fusion',
      'camera',
      'clip-lab',
      'one-sku-bootstrap',
      'pilot-evaluation',
      'planogram',
      'pretrained-vision',
      'local-vision-runtime',
      'cv-dataset',
      'cv-evaluation',
    ];
    for (const moduleName of modulesWithGuards) {
      const guard = join(root, '..', moduleName, 'shadow-mode.spec.ts');
      const source = readFileSync(guard, 'utf8');
      expect(source).toMatch(/checkoutSession|order|paymentIntent|inventory/);
      expect(source).toMatch(/create|update|upsert|delete/);
    }
  });
});
