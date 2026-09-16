import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 30 Reports page.
 *
 * A report is a new window onto data that already has boundaries around it,
 * which makes it the easiest place to lose them. Four properties are pinned:
 *
 *   1. It never writes. No POST/PUT/PATCH/DELETE, no upload, no mutation
 *      endpoint — a reporting surface that can write is a second source of
 *      truth.
 *   2. It is not a side channel for raw CV evidence. The admin CV pages have
 *      their own guards because evidence leaked into the UI before; a
 *      CV-accuracy report must not reach the raw-evidence endpoints or render
 *      media keys, storage paths, crop artifacts or reviewer notes.
 *   3. It never asks for or shows card data, and it stores nothing itself.
 *   4. It keeps the two distinctions the platform paid for: a ledger balance
 *      is not the stock projection, and projection drift is not a stock
 *      variance.
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/ReportsPage.tsx', import.meta.url)),
  'utf8',
);
const utilsSource = readFileSync(
  fileURLToPath(new URL('./reporting-utils.ts', import.meta.url)),
  'utf8',
);

describe('Reports page safety', () => {
  it('reads only — it issues no write of any kind', () => {
    // Every call goes through `api(path)`, whose write form always names a
    // method. None appears here.
    for (const method of ["'POST'", "'PUT'", "'PATCH'", "'DELETE'"]) {
      expect(pageSource).not.toContain(method);
    }
    expect(pageSource).not.toContain('apiUpload');
    expect(pageSource).not.toContain('<form');
    expect(pageSource).not.toContain('onSubmit');
  });

  it('touches only the /reports surface, never a domain mutation route', () => {
    const paths = [...pageSource.matchAll(/api<[^>]*>\(\s*`?['`]([^'`$]*)/g)].map(
      (match) => match[1],
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(
        path.startsWith('/reports') || path.startsWith('/stores')
          ? null
          : `unexpected endpoint ${path}`,
      ).toBeNull();
    }
    for (const forbidden of [
      '/inventory/adjustments',
      '/inventory/movements',
      '/inventory/levels',
      '/shrink-events',
      '/cycle-counts',
      '/returns',
      '/payments/intents',
      '/vision-events',
    ]) {
      expect(pageSource).not.toContain(`'${forbidden}`);
    }
  });

  it('never reaches a raw CV evidence surface', () => {
    for (const needle of [
      '/fusion-evidence',
      '/vlm-readiness',
      '/pilot-evaluations',
      'FusionEvidencePanel',
      'PickupDetectionPanel',
      'evidenceBundle',
      'visionEventId',
      'operatorCropArtifactId',
      'storageKey',
      'rawText',
      'rawPreview',
      'matchScore',
    ]) {
      expect(`${needle}:${pageSource.includes(needle)}`).toBe(`${needle}:false`);
    }
  });

  it('renders the CV report as counts and rates, never as evidence', () => {
    // What the CV section IS allowed to show.
    expect(pageSource).toContain('Predicted action');
    expect(pageSource).toContain('Predicted SKU');
    expect(pageSource).toContain('confusion.action');
    expect(pageSource).toContain('confusion.sku');
    // And it tells the operator what was left out, including the video
    // boundary the server applied.
    expect(pageSource).toContain('scope.excluded');
    expect(pageSource).toMatch(/never shows raw observation evidence/i);
  });

  it.each([['cardNumber'], ['cvv'], ['cvc'], ['pan'], ['instrumentLast4']])(
    'never mentions %s',
    (needle) => {
      // Whole words only: "pan" must not match "<span".
      expect(pageSource).not.toMatch(new RegExp(`\\b${needle}\\b`, 'i'));
    },
  );

  it.each([['localStorage'], ['sessionStorage'], ['document.cookie']])(
    'never persists anything itself in %s',
    (needle) => {
      expect(pageSource.includes(needle)).toBe(false);
    },
  );

  it('shows the ledger as the balance and the projection only as a cross-check', () => {
    expect(pageSource).toContain('Ledger balance');
    expect(pageSource).toContain('Projection (cross-check)');
    expect(pageSource).toMatch(/never the answer/i);
  });

  it('shows projection drift as a platform problem, not a stock variance', () => {
    expect(pageSource).toMatch(/never added together/i);
    expect(pageSource).toMatch(/has NOT been corrected here/i);
    expect(utilsSource).toContain('PLATFORM DEFECT');
  });

  it('says a damaged return is not shrink, and why', () => {
    expect(pageSource).toMatch(/Damaged returns — not shrink/);
    expect(pageSource).toMatch(/writes no ledger movement/i);
    expect(utilsSource).toMatch(/NOT counted as shrink/);
  });

  it('says when every figure was computed, and that nothing is cached', () => {
    expect(pageSource).toContain('asOfLabel');
    expect(utilsSource).toContain('Derived on read at');
    expect(utilsSource).toContain('NOT live');
    expect(pageSource).toMatch(/Nothing here is cached/i);
  });

  it('never fabricates a rate the server declined to compute', () => {
    expect(utilsSource).toContain("'not enough data'");
    expect(pageSource).not.toMatch(/accuracy\.\w+\s*\?\?\s*0/);
  });

  it('collects no free text — only a date window and ids', () => {
    // A saved report definition or a note would be the one way operator prose
    // from this page could reach a persisted column. There is none.
    const textInputs = [...pageSource.matchAll(/type="(\w+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(textInputs)).toEqual(new Set(['date', 'text']));
    expect(pageSource).not.toContain('<textarea');
  });
});
