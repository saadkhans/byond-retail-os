import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 19 Pretrained Vision Evaluation page:
 * the page renders classified codes, SKUs, and normalized numbers only —
 * never model paths, raw OCR text, barcode values, file paths, stream
 * URLs, provider secrets, or raw model logs. It stays on the shadow-only
 * pretrained-vision / planogram surfaces and never reaches the
 * basket-affecting vision-event review path.
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/PretrainedVisionPage.tsx', import.meta.url)),
  'utf8',
);

describe('Pretrained Vision page safety', () => {
  it.each([
    ['/vision-events', 'basket-affecting review endpoint'],
    ['/fusion-evidence', 'raw fusion evidence fetch'],
    ['/vlm-readiness', 'VLM environment details'],
    ['baseUrl', 'provider base URL rendering'],
    ['availableModels', 'installed model list rendering'],
    ['modelPath', 'model path rendering'],
    ['rawText', 'raw OCR text'],
    ['rawPreview', 'raw model output'],
    ['rtsp:', 'stream URL rendering'],
    ['storageKey', 'storage key rendering'],
  ])('never references %s (%s)', (needle) => {
    expect(pageSource.includes(needle)).toBe(false);
  });

  it('uses only the shadow-only pretrained-vision and planogram surfaces', () => {
    expect(pageSource).toContain('pretrainedEvaluatePath');
    expect(pageSource).toContain('/planograms/racks');
  });

  it('presents planogram results with operator-friendly soft-prior labels', () => {
    for (const label of [
      'Expected in this cell',
      'Found in neighboring cell',
      'Possible misplaced product',
      'Cell mapping uncertain',
      'Planogram not configured',
      'Still needs review',
      'No improvement over classical fallback',
    ]) {
      expect(pageSource.includes(label)).toBe(true);
    }
  });

  it('labels real local-runtime evidence as advisory and shows only an opaque model id', () => {
    for (const label of [
      'Detector covered more frames than classical',
      'Hand contact observed by detector',
      'Pretrained output is advisory until gates are approved',
      'real local inference',
    ]) {
      expect(pageSource.includes(label)).toBe(true);
    }
    // The chip shows the registry model id — never a file, directory,
    // interpreter, or worker location.
    expect(pageSource).toContain('provider.runtime.modelId');
    for (const needle of ['modelFile', 'modelRoot', 'python', '.pt', '.onnx']) {
      expect(pageSource.includes(needle)).toBe(false);
    }
  });

  it('never renders similarity/ranking numbers as percentages', () => {
    expect(pageSource).not.toMatch(/topScore \* 100|similarity \* 100/);
  });
});
