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

  it('degrades gracefully when inventory details are redacted (no inventory:read)', () => {
    // Stock rows render only behind the server's detailsVisible flag,
    // and the hidden state explains itself instead of failing the page.
    expect(pageSource).toContain('data.inventory.detailsVisible');
    expect(pageSource).toContain(
      'Inventory details hidden — inventory permission required',
    );
  });

  it('degrades gracefully when video details are redacted (no video-asset:read)', () => {
    expect(pageSource).toContain('data.videoDetailsVisible');
    expect(pageSource).toContain(
      'Video details hidden — video asset permission required',
    );
  });

  it('offers the false-touch action only on NONE ground-truth clips', () => {
    // The server enforces this too — a false touch on a positive clip
    // would mislabel a real pickup/return as NO_OP.
    expect(pageSource).toMatch(/\{isNone \? \([\s\S]{0,800}FALSE_TOUCH/);
  });

  it('never renders the uncalibrated ranking score as a percentage', () => {
    expect(pageSource).not.toMatch(/topScore \* 100/);
  });

  it('remounts the ground-truth form per asset so stale values cannot cross clips', () => {
    // key={selectedAssetId} resets every form field on asset switch, and
    // a null-truth load leaves blank defaults instead of the previous
    // clip's values.
    expect(pageSource).toMatch(
      /<BootstrapGroundTruthForm\s+key=\{selectedAssetId\}/,
    );
    expect(pageSource).toContain('No ground truth saved for this clip yet');
    // Submit is held while THIS clip's truth is loading or failed to
    // load — never persisting values over an unknown annotation.
    expect(pageSource).toContain(
      'disabled={saving || existing.loading || existing.error !== null}',
    );
    expect(pageSource).toContain('Could not load this clip’s ground truth');
  });

  it('hides the fusion summary lines when video details are redacted', () => {
    expect(pageSource).toContain(
      '— hidden (video asset permission required)',
    );
  });
});
