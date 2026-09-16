import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 35 — the shopper surface is PUBLIC, so what it may do is pinned by
 * grep, not by reviewer memory.
 *
 * Four things are enforced:
 *
 *   1. It writes NOTHING. Every effect a shopper causes goes through
 *      StoreFlowService, which owns the idempotency keys, the review gate,
 *      the inventory validation and the audit trail. A `create`/`update`
 *      here would be a second, unaudited commerce path reachable without a
 *      login.
 *
 *   2. It never takes a tenant id from the caller. Tenant scope is read off
 *      the credential row, exactly as AuthGuard reads it off the user row.
 *
 *   3. No card data. Not a field, not a type, not a comment that could
 *      become one. This is the surface an attacker would most like to find
 *      a PAN on.
 *
 *   4. It reaches for no commerce service directly — no checkout, orders,
 *      payments, vision, inventory or journey imports.
 */
describe('shopper boundary', () => {
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

  it('has sources to guard', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never writes to the database', () => {
    const forbidden =
      /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\s*\(/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} calls ${match[0].trim()} — the shopper surface is ` +
              'read-only; every effect belongs to StoreFlowService'
          : null,
      ).toBeNull();
    }
  });

  it('never opens a transaction of its own', () => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toContain('$transaction');
    }
  });

  it('never reads a tenant id from the request', () => {
    // A shopper names nothing. Any of these would mean a client-supplied
    // tenant reached a query.
    const forbidden = [
      '@CurrentTenantId',
      'dto.tenantId',
      'body.tenantId',
      'query.tenantId',
      'params.tenantId',
      'headers.tenantId',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        expect(`${file}:${source.includes(needle) ? needle : ''}`).toBe(
          `${file}:`,
        );
      }
    }
  });

  it('never mentions card data in any form', () => {
    const forbidden =
      /\b(pan|cardNumber|card_number|cvv|cvc|cardholder|expiryMonth|expiryYear|primaryAccountNumber)\b/i;
    for (const file of files) {
      const match = readFileSync(file, 'utf8').match(forbidden);
      expect(
        match
          ? `${file} mentions "${match[0]}" — no card data may exist ` +
              'anywhere on a shopper-facing surface'
          : null,
      ).toBeNull();
    }
  });

  it('imports no commerce service directly', () => {
    const forbidden = [
      '../checkout/',
      '../orders/',
      '../payments/',
      '../vision/',
      '../inventory/',
      '../journey/',
      '../returns/',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        expect(`${file}:${source.includes(needle) ? needle : ''}`).toBe(
          `${file}:`,
        );
      }
    }
  });

  it('keeps every public route in one file, so the surface stays countable', () => {
    const publicFiles = files.filter((file) =>
      readFileSync(file, 'utf8').includes('@Public()'),
    );
    expect(publicFiles.map((file) => file.split(/[\\/]/).pop())).toEqual([
      'shopper.controller.ts',
    ]);
  });
});
