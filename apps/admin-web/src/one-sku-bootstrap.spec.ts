import { describe, expect, it } from 'vitest';
import {
  MANUAL_CROP_REASONS,
  REFERENCE_ANGLES,
  basketDeltaLabel,
  gateProgress,
  oneSkuReportPath,
  overlayRectStyle,
  validateManualCrop,
} from './one-sku-bootstrap-utils';

describe('oneSkuReportPath', () => {
  it('targets the read-only report endpoint, tenant-free (JWT carries it)', () => {
    expect(oneSkuReportPath('prod-1')).toBe('/one-sku-bootstrap/prod-1/report');
  });

  it('URL-encodes hostile product ids instead of splicing them raw', () => {
    expect(oneSkuReportPath('a/b?x=1')).toBe(
      '/one-sku-bootstrap/a%2Fb%3Fx%3D1/report',
    );
  });
});

describe('reference angle checklist', () => {
  it('covers the seven recommended capture angles', () => {
    expect(REFERENCE_ANGLES.map((angle) => angle.key)).toEqual([
      'front',
      'left',
      'right',
      'back',
      'top',
      'shelf',
      'hand',
    ]);
  });
});

describe('basketDeltaLabel', () => {
  it('formats pickup, return, and false-touch deltas', () => {
    expect(basketDeltaLabel(2)).toBe('+2');
    expect(basketDeltaLabel(-1)).toBe('−1');
    expect(basketDeltaLabel(0)).toBe('0');
  });
});

describe('validateManualCrop', () => {
  const good = {
    timestampMs: '1500',
    x: '30',
    y: '25',
    width: '50',
    height: '60',
    reason: 'PRODUCT_PICKUP',
  };

  it('accepts a valid draft and emits ONLY numeric fields plus the enum reason', () => {
    const result = validateManualCrop(good, 8000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        timestampMs: 1500,
        x: 30,
        y: 25,
        width: 50,
        height: 60,
        reason: 'PRODUCT_PICKUP',
      });
      // The payload's closed key set is the unsafe-content guarantee:
      // there is no field a path, URL, or credential could travel in.
      expect(Object.keys(result.payload).sort()).toEqual([
        'height',
        'reason',
        'timestampMs',
        'width',
        'x',
        'y',
      ]);
    }
  });

  it('omits the reason key entirely when blank', () => {
    const result = validateManualCrop({ ...good, reason: '' }, 8000);
    expect(result.ok && 'reason' in result.payload).toBe(false);
  });

  it('rejects free-text reasons — paths and sources are unrepresentable', () => {
    for (const hostile of [
      'C:/videos/raw.mp4',
      '../../etc/passwd',
      'https://camera.local/stream',
      'ANY_FREE_TEXT',
    ]) {
      const result = validateManualCrop({ ...good, reason: hostile }, 8000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.reason).toBeDefined();
      }
    }
  });

  it('rejects non-integer coordinates instead of coercing them', () => {
    for (const bad of ['', ' ', '-5', '1.5', '1e3', 'ten', '10px']) {
      const result = validateManualCrop({ ...good, x: bad }, 8000);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects zero-sized boxes and out-of-range timestamps', () => {
    expect(validateManualCrop({ ...good, width: '0' }, 8000).ok).toBe(false);
    expect(validateManualCrop({ ...good, timestampMs: '8000' }, 8000).ok).toBe(
      false,
    );
    expect(validateManualCrop({ ...good, timestampMs: '7999' }, 8000).ok).toBe(
      true,
    );
  });

  it('keeps the reason list identical to the server enum', () => {
    expect([...MANUAL_CROP_REASONS]).toEqual([
      'PRODUCT_PICKUP',
      'PRODUCT_RETURN',
      'SHELF_AUDIT',
      'CART_INSERTION',
      'OCR_REVIEW',
      'VLM_REVIEW',
    ]);
  });
});

describe('overlayRectStyle', () => {
  it('scales a native-pixel box to percentages over the frame', () => {
    expect(
      overlayRectStyle(
        { x: 480, y: 270, width: 960, height: 540 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ left: '25.00%', top: '25.00%', width: '50.00%', height: '50.00%' });
  });

  it('clamps instead of overflowing the preview', () => {
    const rect = overlayRectStyle(
      { x: 1800, y: 1000, width: 900, height: 500 },
      { width: 1920, height: 1080 },
    );
    expect(rect?.left).toBe('93.75%');
    expect(rect?.width).toBe('46.88%');
  });

  it('returns null for a degenerate frame', () => {
    expect(
      overlayRectStyle({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 0 }),
    ).toBeNull();
  });
});

describe('gateProgress', () => {
  it('counts required gates only', () => {
    expect(
      gateProgress([
        { satisfied: true, required: true },
        { satisfied: false, required: true },
        { satisfied: false, required: false },
      ]),
    ).toEqual({ satisfied: 1, total: 2 });
  });
});

import {
  CROP_WARNING_LABELS,
  FAILURE_REASON_LABELS,
  ReportSlice,
  deriveStatusHeader,
  nextBestAction,
  oneSkuEvaluationRunPath,
  oneSkuReviewPath,
} from './one-sku-bootstrap-utils';

function slice(over: Partial<ReportSlice> = {}): ReportSlice {
  const gates = (satisfiedKeys: string[]) =>
    [
      'REFERENCES_MIN',
      'EMBEDDINGS_BUILT',
      'INVENTORY_STOCKED',
      'CLEAN_CROP',
      'PICKUP_EXAMPLES',
      'RETURN_EXAMPLES',
      'FALSE_TOUCH_EXAMPLES',
      'ALL_REVIEWED',
      'EVALUATION_RUN_LINKED',
    ].map((key) => ({
      key,
      satisfied: satisfiedKeys.includes(key),
      required: true,
    }));
  return {
    references: {
      referenceCount: 9,
      minRequired: 5,
      inferenceReady: true,
      embeddingCount: 9,
      embeddingsBuilt: true,
    },
    inventory: { stocked: true },
    counts: {
      totalClips: 9,
      reviewedPickupExamples: 5,
      reviewedReturnExamples: 2,
      reviewedFalseTouchExamples: 2,
      unreviewedClips: 0,
    },
    latest: {},
    videos: [],
    linkedEvaluationRun: { reviewCount: 9 },
    gates: {
      items: gates([
        'REFERENCES_MIN',
        'EMBEDDINGS_BUILT',
        'INVENTORY_STOCKED',
        'CLEAN_CROP',
        'PICKUP_EXAMPLES',
        'RETURN_EXAMPLES',
        'FALSE_TOUCH_EXAMPLES',
        'ALL_REVIEWED',
        'EVALUATION_RUN_LINKED',
      ]),
      readyForDatasetImprovement: true,
    },
    ...over,
  };
}

describe('bootstrap action paths', () => {
  it('targets the record-only bootstrap endpoints, never vision-event review', () => {
    expect(oneSkuEvaluationRunPath('p1')).toBe(
      '/one-sku-bootstrap/p1/evaluation-run',
    );
    expect(oneSkuReviewPath('p1', 'va-1')).toBe(
      '/one-sku-bootstrap/p1/videos/va-1/review',
    );
  });

  it('URL-encodes hostile ids', () => {
    expect(oneSkuReviewPath('a/b', 'c?d')).toBe(
      '/one-sku-bootstrap/a%2Fb/videos/c%3Fd/review',
    );
  });
});

describe('warning and failure labels', () => {
  it('has a human-readable label for every crop warning code', () => {
    for (const code of [
      'PRODUCT_TOO_SMALL',
      'HIGH_OCCLUSION',
      'LOW_SHARPNESS',
      'CROP_MISALIGNED',
      'NO_CLEAR_PRODUCT_FRAME',
      'UNKNOWN_GEOMETRY',
    ]) {
      expect(CROP_WARNING_LABELS[code]).toBeTruthy();
    }
  });

  it('labels the missed-positive failure reason', () => {
    expect(FAILURE_REASON_LABELS.MISSED_POSITIVE_EVENT).toContain(
      'Missing positive event',
    );
  });
});

describe('deriveStatusHeader', () => {
  it('renders five chips, all green for a healthy SKU', () => {
    const chips = deriveStatusHeader(slice());
    expect(chips.map((chip) => chip.key)).toEqual([
      'references',
      'inventory',
      'evidence',
      'crop',
      'dataset',
    ]);
    expect(chips.every((chip) => chip.tone === 'ok')).toBe(true);
  });

  it('reflects missing references and unreviewed clips', () => {
    const chips = deriveStatusHeader(
      slice({
        references: {
          referenceCount: 2,
          minRequired: 5,
          inferenceReady: false,
          embeddingCount: 0,
          embeddingsBuilt: false,
        },
        counts: {
          totalClips: 3,
          reviewedPickupExamples: 0,
          reviewedReturnExamples: 0,
          reviewedFalseTouchExamples: 0,
          unreviewedClips: 2,
        },
      }),
    );
    expect(chips.find((chip) => chip.key === 'references')?.tone).toBe('down');
    expect(chips.find((chip) => chip.key === 'evidence')?.tone).toBe('warn');
    expect(chips.find((chip) => chip.key === 'evidence')?.detail).toContain(
      '2 need review',
    );
  });
});

describe('nextBestAction', () => {
  it('walks the workflow in priority order', () => {
    expect(
      nextBestAction(
        slice({
          references: {
            referenceCount: 2,
            minRequired: 5,
            inferenceReady: false,
            embeddingCount: 0,
            embeddingsBuilt: false,
          },
        }),
      ).key,
    ).toBe('UPLOAD_REFERENCES');
    expect(
      nextBestAction(
        slice({
          references: {
            referenceCount: 6,
            minRequired: 5,
            inferenceReady: true,
            embeddingCount: 2,
            embeddingsBuilt: false,
          },
        }),
      ).key,
    ).toBe('BUILD_EMBEDDINGS');
    expect(
      nextBestAction(slice({ inventory: { stocked: false } })).key,
    ).toBe('STOCK_SKU');
    expect(
      nextBestAction(
        slice({
          counts: {
            totalClips: 0,
            reviewedPickupExamples: 0,
            reviewedReturnExamples: 0,
            reviewedFalseTouchExamples: 0,
            unreviewedClips: 0,
          },
        }),
      ).key,
    ).toBe('UPLOAD_CLIP');
  });

  it('asks for a manual crop fix before more reviews', () => {
    const report = slice();
    report.gates.items = report.gates.items.map((item) =>
      item.key === 'CLEAN_CROP' ? { ...item, satisfied: false } : item,
    );
    expect(nextBestAction(report).key).toBe('FIX_CROP');
  });

  it('asks to link the evaluation run before declaring done', () => {
    const report = slice({ linkedEvaluationRun: null });
    report.gates.items = report.gates.items.map((item) =>
      item.key === 'EVALUATION_RUN_LINKED' ? { ...item, satisfied: false } : item,
    );
    expect(nextBestAction(report).key).toBe('LINK_EVALUATION_RUN');
  });

  it('ends at the dataset-improvement CTA when everything is ready', () => {
    expect(nextBestAction(slice()).key).toBe('SEND_TO_DATASET');
  });
});
