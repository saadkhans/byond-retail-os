import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reporting reads. It never writes domain data, and it never becomes a second
 * source of truth.
 *
 * That sentence is the whole phase, and it is exactly the kind of guarantee
 * that decays quietly — one convenient `update`, one cached total, one
 * "temporary" evidence field on a CV report and it is gone, with every test
 * still green. So it is restated here as a grep guard over the WHOLE
 * directory, the way the reverse flow (`returns/boundary.spec.ts`) and the CV
 * pages (`*-page-safety.spec.ts`) pin theirs.
 *
 * Five things are enforced:
 *
 *   1. No write of any kind reaches the database from this module.
 *   2. Nothing is cached, materialised or scheduled — every number is derived
 *      on read, so "as of when" can never be a lie.
 *   3. Every read names the tenant in its own predicate.
 *   4. No raw card data and no free-text input anywhere.
 *   5. The CV-accuracy report never projects raw observation evidence, media
 *      keys or storage paths.
 *
 * If one of these fails, the fix is the code — never this file.
 */
describe('reporting boundary', () => {
  const root = __dirname;

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
  const read = (file: string) => readFileSync(file, 'utf8');

  it('finds the module it is guarding', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it('never writes a row, in any table, in any form', () => {
    // Deliberately broad: `<anything>.create/update/upsert/delete`. Reporting
    // has nothing to persist, so there is no legitimate exception to carve
    // out — which is what makes the guard worth having.
    const forbidden =
      /\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    for (const file of files) {
      const match = read(file).match(forbidden);
      expect(
        match
          ? `${file} calls ${match[0]} — reporting reads; a write here would ` +
              'make it a second source of truth'
          : null,
      ).toBeNull();
    }
  });

  it('never opens a transaction or runs an executing raw statement', () => {
    for (const file of files) {
      const source = read(file);
      expect(source).not.toContain('$transaction');
      expect(source).not.toContain('$executeRaw');
      expect(source).not.toContain('$executeRawUnsafe');
      expect(source).not.toContain('$queryRawUnsafe');
    }
  });

  it('never appends to the inventory ledger or touches a stock level', () => {
    // The strongest form of "reporting adds no movement, ever".
    for (const file of files) {
      const source = read(file);
      expect(source).not.toContain('applyMovement');
      expect(source).not.toMatch(/\binventoryLevel\s*\.\s*(?!findMany)/);
    }
  });

  it('never writes an audit log entry', () => {
    // Nothing happened. An audit row would claim otherwise, and its `reason`
    // is the field past reviews found unredacted free text in.
    for (const file of files) {
      const source = read(file);
      expect(source).not.toContain('AuditLogService');
      expect(source).not.toContain('auditLog');
      expect(source).not.toContain('AuditAction');
    }
  });

  it('caches, materialises and schedules nothing', () => {
    // If any of these ever appear, staleness stops being structurally
    // impossible and has to be shown in the payload instead. The constant
    // `stale: false` in reporting.constants.ts is only honest while this
    // passes.
    const forbidden = [
      'setInterval',
      'setTimeout',
      '@Cron',
      'CacheModule',
      'CACHE_MANAGER',
      'cacheManager',
      'memoize',
      'CREATE MATERIALIZED',
      'REFRESH MATERIALIZED',
    ];
    for (const file of files) {
      for (const needle of forbidden) {
        expect(`${file}:${read(file).includes(needle)}`).toBe(`${file}:false`);
      }
    }
  });

  it('declares every report as derived on read', () => {
    const constants = read(join(root, 'reporting.constants.ts'));
    expect(constants).toContain("'DERIVED_ON_READ'");
    expect(constants).toContain('readonly stale: false');
    // Every report body carries the provenance block, so a number is never
    // read without "as of when" next to it.
    const service = read(join(root, 'reporting.service.ts'));
    const reports = service.match(/provenance: provenance\(/g) ?? [];
    expect(reports.length).toBeGreaterThanOrEqual(6);
  });

  it('carries the tenant in every read predicate', () => {
    // Same rule the write guards elsewhere enforce, applied to reads: a
    // report predicate that leans on a prior lookup instead of naming the
    // tenant is how one tenant's numbers end up in another's report.
    const readCall =
      /this\.prisma\.(\w+)\.(findFirst|findMany|findUnique|groupBy|aggregate|count)\(/g;
    let sites = 0;
    for (const file of files) {
      const source = read(file);
      for (const match of source.matchAll(readCall)) {
        sites += 1;
        const [, model, operation] = match;
        // The arguments of the call, or the tenant-scoped predicate the call
        // reuses — which the next assertion proves carries the tenant too.
        const args = source.slice(match.index ?? 0, (match.index ?? 0) + 900);
        expect(
          args.includes('tenantId') || args.includes('tenantScopedWhere')
            ? null
            : `${file}: ${model}.${operation} has no tenantId in its predicate`,
        ).toBeNull();
      }
      // A reused predicate must itself be tenant-scoped, and must be NAMED
      // for it — an anonymous `where` shared between calls is exactly how the
      // tenant goes missing without anyone noticing.
      for (const shared of source.matchAll(
        /const tenantScopedWhere = \{([\s\S]{0,600}?)\n {4}\};/g,
      )) {
        expect(shared[1]).toContain('tenantId');
      }
    }
    expect(sites).toBeGreaterThanOrEqual(12);
  });

  it('never names, accepts or stores card data', () => {
    for (const file of files) {
      const source = read(file);
      for (const needle of ['cardNumber', 'cvv', 'cvc', 'instrumentLast4']) {
        expect(new RegExp(`\\b${needle}\\b`, 'i').test(source)).toBe(false);
      }
    }
  });

  it('accepts no free text at all, so nothing here needs screening', () => {
    // Reporting stores no report definitions, no saved filters and no notes.
    // With no persisted free-text field there is no path for payment data to
    // reach a column — which is why this module does not (and must not need
    // to) call containsSensitiveFreeText.
    const dto = read(join(root, 'reporting.dto.ts'));
    expect(dto).not.toMatch(/\b(name|note|notes|reason|description|comment|label)\?:/);
    expect(dto).not.toContain('MaxLength');
    for (const file of files) {
      expect(read(file)).not.toContain('@Body()');
    }
  });

  it('never projects raw CV evidence, media keys or storage paths', () => {
    // The admin CV pages have safety guards because raw evidence leaked into
    // the UI before. A CV-accuracy report is a new surface over the same
    // rows, so it honours the same rules: counts of verdicts and catalog
    // SKUs, never the things the evidence lives in.
    const forbidden = [
      'evidenceBundle',
      'visionEventId',
      'operatorCropArtifactId',
      'evidenceCropArtifactId',
      'storageKey',
      'storagePath',
      'videoAssetId',
      'rawText',
      'rawPreview',
      'matchScore',
      'evidenceScore',
      'reasonCodes',
      'vlmReviewId',
    ];
    for (const file of files) {
      const source = read(file);
      for (const needle of forbidden) {
        expect(`${file}:${needle}:${source.includes(needle)}`).toBe(
          `${file}:${needle}:false`,
        );
      }
    }
  });

  it('applies the same video boundary the pilot observation route applies', () => {
    const service = read(join(root, 'reporting.service.ts'));
    expect(service).toContain("'video-asset:read'");
    expect(service).toContain("isEnabledForTenant(tenantId, 'video-ingest')");
    const repository = read(join(root, 'reporting.repository.ts'));
    expect(repository).toContain('FUSION_SHADOW');
  });

  it('exposes only GET routes', () => {
    const controller = read(join(root, 'reporting.controller.ts'));
    for (const verb of ['@Post(', '@Put(', '@Patch(', '@Delete(']) {
      expect(controller).not.toContain(verb);
    }
    expect((controller.match(/@Get\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('imports no domain module it could ask to change something', () => {
    const module = read(join(root, 'reporting.module.ts'));
    // The @Module imports array itself, not the prose around it.
    const imports = module.match(/imports:\s*\[([^\]]*)\]/)?.[1] ?? 'MISSING';
    expect(imports.trim()).toBe('PlatformModulesModule');
    // And nothing is injected from a domain module either.
    const importStatements = module.match(/^import .*$/gm) ?? [];
    for (const forbidden of [
      'InventoryModule',
      'OrdersModule',
      'ReturnsModule',
      'PricingModule',
      'CheckoutModule',
      'PaymentsModule',
      'InventoryRepository',
    ]) {
      expect(importStatements.join('\n')).not.toContain(forbidden);
    }
  });
});
