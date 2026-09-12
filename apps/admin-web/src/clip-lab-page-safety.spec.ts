import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 22 Clip Lab page and its batch tab: they
 * render classified codes, SKUs, and normalized numbers only — never model
 * paths, raw OCR text, storage keys, stream URLs, or ranking scores dressed
 * up as percentages — they mark their mandatory fields, and the batch tab
 * keeps every per-clip gate (one request in flight, a human screening
 * decision, ground truth saved only by the operator).
 */
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const pageSource = read('./pages/ClipLabPage.tsx');
const batchSource = read('./pages/ClipLabBatchSection.tsx');

const FORBIDDEN: [string, string][] = [
  ['/vision-events', 'basket-affecting review endpoint'],
  ['/fusion-evidence', 'raw fusion evidence fetch'],
  ['/vlm-readiness', 'VLM environment details'],
  ['modelPath', 'model path rendering'],
  ['rawText', 'raw OCR text'],
  ['rawPreview', 'raw model output'],
  ['rtsp:', 'stream URL rendering'],
  ['storageKey', 'storage key rendering'],
];

describe.each([
  ['ClipLabPage', pageSource],
  ['ClipLabBatchSection', batchSource],
])('%s safety', (_name, source) => {
  it.each(FORBIDDEN)('never references %s (%s)', (needle) => {
    expect(source.includes(needle)).toBe(false);
  });

  it('never computes a percentage of a ranking score inline (the labeled helper is the only door)', () => {
    expect(/score \* 100|similarity \* 100|fusedScore \* 100|confidence \* 100/.test(source)).toBe(false);
    expect(source).toContain('percentLabel(');
    expect(source).toContain('not probabilities');
    expect(source).toContain('Still needs review');
  });
});

describe('Clip Lab page safety', () => {
  it('uses only the Clip Lab, upload, screening, planogram, and ground-truth surfaces', () => {
    for (const path of ['/lab-run', '/lab-report', '/planograms/racks', '/screening-preview', '/screening', '/ground-truth']) {
      expect(pageSource).toContain(path);
    }
    expect(pageSource).toContain('Confidence summary');
  });

  it('marks the mandatory fields and keeps the human screening decision explicit', () => {
    for (const label of ['Clip file *', 'Store *', 'Unit *', 'Rack *', 'Clip *', 'Approve screening *', 'Operator attestations *']) {
      expect(pageSource.includes(label)).toBe(true);
    }
    expect(pageSource).toContain('leave blank if the rack fills the frame');
    expect(pageSource).toContain('scoped to planogram');
    expect(pageSource).toContain('Batch upload');
    expect(pageSource).toContain('Single clip');
  });

  it('binds the store, unit, and rack at upload', () => {
    expect(pageSource).toContain("formData.append('planogramRackCode'");
    expect(pageSource).toContain("formData.append('locationId'");
    expect(pageSource).toContain("formData.append('unitId'");
  });
});

describe('Clip Lab batch safety', () => {
  it('marks the one-time settings and the per-clip human gates', () => {
    for (const label of [
      'Store *',
      'Unit *',
      'Rack *',
      'Operator attestations *',
      'Screening review grid *',
      'Approve all previewed',
      'You inspected every frame set',
      'name not understood',
      'leave blank if the rack fills the frame',
    ]) {
      expect(batchSource.includes(label)).toBe(true);
    }
  });

  it('applies the same attestations and binding to every file, one request at a time', () => {
    expect(batchSource).toContain('UPLOAD_ATTESTATIONS');
    expect(batchSource).toContain("formData.append('planogramRackCode'");
    expect(batchSource).toContain("formData.append('locationId'");
    expect(batchSource).toContain("formData.append('unitId'");
    expect(batchSource).toContain('createSequentialRunner');
    // Never fan out uploads or lab runs: the upload gate and the local
    // runtime are single in flight by design.
    expect(/Promise\.all\(/.test(batchSource)).toBe(false);
  });

  it('never approves screening without frames on screen, from exactly one call site', () => {
    expect(batchSource.split("'APPROVE'").length - 1).toBe(1);
    expect(batchSource.split("'REJECT'").length - 1).toBe(1);
    expect(batchSource).toContain('previewIsFresh(');
    expect(batchSource).toContain("no frames were shown for this clip");
  });

  it('touches only the allowed API surfaces', () => {
    const allowed = [
      '/video-assets',
      '/screening-preview',
      '/screening',
      '/ground-truth',
      '/lab-run',
      '/planograms/racks',
      '/units',
      '/stores',
      '/catalog/products',
      '/auth/login',
    ];
    const paths = [...batchSource.matchAll(/`\/[a-z/-]+|'\/[a-z/-]+/g)].map((m) => m[0].slice(1));
    for (const path of paths) {
      expect(allowed.some((prefix) => path.startsWith(prefix))).toBe(true);
    }
  });

  it('re-authenticates inline without touching the auth context', () => {
    expect(batchSource).toContain('setToken(');
    expect(batchSource).not.toContain('useAuth(');
    expect(batchSource).not.toContain('clearToken(');
  });
});
