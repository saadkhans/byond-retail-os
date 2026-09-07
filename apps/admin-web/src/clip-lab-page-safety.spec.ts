import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 22 Clip Lab page: it renders classified
 * codes, SKUs, and normalized numbers only — never model paths, raw OCR
 * text, storage keys, stream URLs, or ranking scores dressed up as
 * percentages — and it marks its mandatory fields.
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/ClipLabPage.tsx', import.meta.url)),
  'utf8',
);

describe('Clip Lab page safety', () => {
  it.each([
    ['/vision-events', 'basket-affecting review endpoint'],
    ['/fusion-evidence', 'raw fusion evidence fetch'],
    ['/vlm-readiness', 'VLM environment details'],
    ['modelPath', 'model path rendering'],
    ['rawText', 'raw OCR text'],
    ['rawPreview', 'raw model output'],
    ['rtsp:', 'stream URL rendering'],
    ['storageKey', 'storage key rendering'],
  ])('never references %s (%s)', (needle) => {
    expect(pageSource.includes(needle)).toBe(false);
  });

  it('never renders ranking scores as percentages', () => {
    expect(/score \* 100|similarity \* 100|fusedScore \* 100/.test(pageSource)).toBe(false);
  });

  it('uses only the Clip Lab, upload, screening, planogram, and ground-truth surfaces', () => {
    for (const path of ['/lab-run', '/lab-report', '/planograms/racks', '/screening-preview', '/screening', '/ground-truth']) {
      expect(pageSource).toContain(path);
    }
  });

  it('marks the mandatory fields and keeps the human screening decision explicit', () => {
    for (const label of ['Clip file *', 'Store *', 'Rack *', 'Clip *', 'Approve screening *', 'Operator attestations *']) {
      expect(pageSource.includes(label)).toBe(true);
    }
    expect(pageSource).toContain('leave blank if the rack fills the frame');
    expect(pageSource).toContain('Still needs review');
    expect(pageSource).toContain('scoped to planogram');
  });

  it('binds the store and rack at upload', () => {
    expect(pageSource).toContain("formData.append('planogramRackCode'");
    expect(pageSource).toContain("formData.append('locationId'");
  });
});
