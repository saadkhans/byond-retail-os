import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pins for the shopper app.
 *
 * A shopper-facing bundle is the surface an attacker reaches first and a
 * regulator reads first, so the rules that make it safe are grepped, not
 * remembered:
 *
 *   1. NO CARD DATA. Not a field, not a handler, not a type. Payment is the
 *      API's simulated provider abstraction; this app reports what it did.
 *   2. NO SECRETS IN THE BUNDLE. One environment variable, and it is a URL.
 *   3. NOTHING SENSITIVE IN A URL. The credential travels in a header.
 *   4. NO STAFF SURFACE. The app calls three shopper endpoints and no other.
 *   5. NO TENANT, STORE OR SHOPPER IDS anywhere in the client.
 */
const here = dirname(fileURLToPath(import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.spec.ts')) {
      return [];
    }
    return [path];
  });

const files = sourceFiles(here);
const sources = files.map((file) => [file, readFileSync(file, 'utf8')] as const);

describe('shopper app safety', () => {
  it('has sources to guard', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('collects no card data, in any spelling', () => {
    // The ONE permitted mention is the reassurance shown to the shopper, so
    // the check is for the mechanisms — identifiers, input types, handlers —
    // not for the English word in a sentence.
    const forbidden = [
      /\bcardNumber\b/i,
      /\bcard_number\b/i,
      /\bcardholder\b/i,
      /\bcvv\b/i,
      /\bcvc\b/i,
      /\bexpiry(Month|Year)\b/i,
      /\bprimaryAccountNumber\b/i,
      /\bpan\b/,
      /autocomplete=["'{]?cc-/i,
      /type=["']tel["']/i,
    ];
    for (const [file, source] of sources) {
      for (const pattern of forbidden) {
        expect(`${file}:${pattern.source}:${pattern.test(source)}`).toBe(
          `${file}:${pattern.source}:false`,
        );
      }
    }
  });

  it('has exactly one text-entry field in the whole app, and it is the entry code', () => {
    const inputs = sources.flatMap(([file, source]) =>
      [...source.matchAll(/<input\b/g)].map(() => file),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatch(/EntryScreen\.tsx$/);
    // Free text a shopper types would have to be screened the way the API
    // screens it before anything persisted it. Nothing here is free text and
    // nothing here is persisted, so there is nothing to screen.
    const entry = sources.find(([file]) => file.endsWith('EntryScreen.tsx'))![1];
    expect(entry).toContain('type="password"');
    expect(entry).toContain('autoComplete="off"');
    expect(/<textarea\b/.test(entry)).toBe(false);
  });

  it('tells the shopper, on every screen, that it never asks for card details', () => {
    const screens = sources.filter(([file]) => file.includes('screens'));
    expect(screens.length).toBeGreaterThanOrEqual(4);
    for (const [file, source] of screens) {
      expect(`${file}:${source.includes('never ask for card details')}`).toBe(
        `${file}:true`,
      );
    }
  });

  it('reads exactly one environment variable, and it is not a secret', () => {
    const reads = sources.flatMap(([, source]) => [
      ...source.matchAll(/import\.meta\.env\.(\w+)/g),
    ].map((match) => match[1]));
    expect([...new Set(reads)]).toEqual(['VITE_API_BASE_URL']);
  });

  it('never reaches for a token, a password or a key', () => {
    const forbidden = [
      /accessToken/i,
      /refreshToken/i,
      /apiKey/i,
      /clientSecret/i,
      /Bearer \$\{/,
      /byond\.admin\./,
    ];
    for (const [file, source] of sources) {
      for (const pattern of forbidden) {
        expect(`${file}:${pattern.source}:${pattern.test(source)}`).toBe(
          `${file}:${pattern.source}:false`,
        );
      }
    }
  });

  it('never persists anything in localStorage, cookies or the URL', () => {
    for (const [file, source] of sources) {
      for (const needle of [
        'localStorage',
        'document.cookie',
        'history.pushState',
        'location.search',
        'location.hash',
        'URLSearchParams',
      ]) {
        expect(`${file}:${source.includes(needle) ? needle : ''}`).toBe(
          `${file}:`,
        );
      }
    }
  });

  it('calls only the three shopper endpoints', () => {
    const paths = sources.flatMap(([, source]) =>
      [...source.matchAll(/'(\/[a-z0-9/-]+)'/g)].map((match) => match[1]),
    );
    expect([...new Set(paths)].sort()).toEqual([
      '/shopper/basket',
      '/shopper/exit',
      '/shopper/session',
    ]);
  });

  it('never renders or logs the credential', () => {
    for (const [file, source] of sources) {
      // getCredential() exists to build one header. It must not reach JSX.
      expect(`${file}:${/\{\s*getCredential\(\)/.test(source)}`).toBe(
        `${file}:false`,
      );
      expect(`${file}:${/console\.(log|warn|error|info|debug)/.test(source)}`).toBe(
        `${file}:false`,
      );
    }
  });

  it('never names a tenant, a store, a unit or another shopper', () => {
    for (const [file, source] of sources) {
      for (const needle of [
        'tenantId',
        'locationId',
        'unitId',
        'shopperId',
        'checkoutSessionId',
        'productId',
      ]) {
        expect(`${file}:${source.includes(needle) ? needle : ''}`).toBe(
          `${file}:`,
        );
      }
    }
  });
});
