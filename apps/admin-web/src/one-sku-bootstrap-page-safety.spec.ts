import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the One SKU Bootstrap page (Codex P1): the page
 * must stay on the RECORD-ONLY bootstrap surface. It must never
 * - call the vision-event review endpoint (its APPROVE/OVERRIDE path can
 *   mutate checkout-session basket lines),
 * - mount the raw fusion/detection panels, or
 * - fetch the raw fusion-evidence / VLM-readiness responses (barcode
 *   values, OCR text, provider base URLs, installed model names).
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/OneSkuBootstrapPage.tsx', import.meta.url)),
  'utf8',
);
const utilsSource = readFileSync(
  fileURLToPath(new URL('./one-sku-bootstrap-utils.ts', import.meta.url)),
  'utf8',
);

describe('One SKU Bootstrap page safety', () => {
  it.each([
    ['/vision-events', 'basket-affecting review endpoint'],
    ['/fusion-evidence', 'raw fusion evidence fetch'],
    ['/vlm-readiness', 'VLM environment details'],
    ['FusionEvidencePanel', 'raw fusion panel'],
    ['PickupDetectionPanel', 'panel with basket-affecting review actions'],
    ['baseUrl', 'provider base URL rendering'],
    ['availableModels', 'installed model list rendering'],
    ['rawText', 'raw OCR text'],
    ['rawPreview', 'raw model output'],
  ])('never references %s (%s)', (needle) => {
    expect(pageSource.includes(needle)).toBe(false);
    expect(utilsSource.includes(needle)).toBe(false);
  });

  it('records corrections only through the bootstrap review path', () => {
    expect(pageSource).toContain('oneSkuReviewPath');
  });

  it('resets upload attestations after every successful upload', () => {
    expect(pageSource).toContain('setAttested({})');
  });
});
