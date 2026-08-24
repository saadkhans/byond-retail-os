import {
  SafeFusionSummary,
  applyOperatorCrop,
  deriveCropWarnings,
  deriveFailureReasons,
  evaluateGates,
  fusionFrameDimsFor,
  gatingCropWarnings,
  safeFusionSummary,
} from './one-sku-bootstrap.report';

const cleanCrop = {
  phase: 'peak',
  timestampMs: 1200,
  box: { x: 120, y: 60, width: 180, height: 200 },
  sharpness: 24,
  occlusion: 0.05,
  brightness: 128,
  selected: true,
  qualityKnown: true,
};

// The FULL fusion frame for a 1920x1080 source: 640x360.
const DIMS = { width: 640, height: 360 };

describe('fusionFrameDimsFor', () => {
  it('mirrors the pipeline FULL analysis frame (640-wide, aspect kept, even)', () => {
    expect(fusionFrameDimsFor({ width: 1920, height: 1080 })).toEqual({
      width: 640,
      height: 360,
    });
  });

  it('never upscales a small source', () => {
    expect(fusionFrameDimsFor({ width: 320, height: 240 })).toEqual({
      width: 320,
      height: 240,
    });
  });

  it('returns null without probed dimensions', () => {
    expect(fusionFrameDimsFor(null)).toBeNull();
    expect(fusionFrameDimsFor({ width: null, height: 720 })).toBeNull();
  });
});

describe('deriveCropWarnings', () => {
  it('flags a missing selected crop as NO_CLEAR_PRODUCT_FRAME', () => {
    expect(deriveCropWarnings(null, DIMS)).toEqual(['NO_CLEAR_PRODUCT_FRAME']);
  });

  it('passes a clean, well-sized crop with no warnings', () => {
    expect(deriveCropWarnings(cleanCrop, DIMS)).toEqual([]);
  });

  it('does not falsely flag a valid crop in the 640-scale fusion geometry', () => {
    // Codex P1: a 192-wide mirror made this exact crop look out of frame.
    const wideCrop = {
      ...cleanCrop,
      box: { x: 400, y: 200, width: 200, height: 150 },
    };
    expect(deriveCropWarnings(wideCrop, DIMS)).toEqual([]);
  });

  it('classifies the observed failure: blurry background crop with heavy occlusion', () => {
    // The Nescafe-mapped-to-SKU-LIME-GREEN case: sharpness 0.9-2.4,
    // occlusion 51-56%, crop mostly table — must warn loudly.
    const warnings = deriveCropWarnings(
      { ...cleanCrop, sharpness: 1.4, occlusion: 0.53 },
      DIMS,
    );
    expect(warnings).toContain('HIGH_OCCLUSION');
    expect(warnings).toContain('LOW_SHARPNESS');
    expect(warnings).toContain('NO_CLEAR_PRODUCT_FRAME');
  });

  it('flags a tiny product box as PRODUCT_TOO_SMALL', () => {
    const warnings = deriveCropWarnings(
      { ...cleanCrop, box: { x: 10, y: 10, width: 20, height: 10 } },
      DIMS,
    );
    expect(warnings).toEqual(['PRODUCT_TOO_SMALL']);
  });

  it('flags a box outside the fusion frame as CROP_MISALIGNED', () => {
    const warnings = deriveCropWarnings(
      { ...cleanCrop, box: { x: 600, y: 300, width: 200, height: 150 } },
      DIMS,
    );
    expect(warnings).toEqual(['CROP_MISALIGNED']);
  });

  it('flags a degenerate box as CROP_MISALIGNED even without frame dims', () => {
    const warnings = deriveCropWarnings(
      { ...cleanCrop, box: { x: 0, y: 0, width: 0, height: 12 } },
      null,
    );
    expect(warnings).toEqual(['CROP_MISALIGNED']);
  });

  it('reports UNKNOWN_GEOMETRY (never a false CROP_MISALIGNED) without frame dims', () => {
    expect(
      deriveCropWarnings(
        { ...cleanCrop, box: { x: 10, y: 10, width: 40, height: 40 } },
        null,
      ),
    ).toEqual(['UNKNOWN_GEOMETRY']);
  });

  it('skips quality checks for an operator crop (no pixel metrics exist)', () => {
    expect(
      deriveCropWarnings(
        { ...cleanCrop, sharpness: 0, occlusion: 0, qualityKnown: false },
        DIMS,
      ),
    ).toEqual([]);
  });
});

describe('gatingCropWarnings', () => {
  it('treats UNKNOWN_GEOMETRY as advisory, everything else as gating', () => {
    expect(
      gatingCropWarnings(['UNKNOWN_GEOMETRY', 'HIGH_OCCLUSION']),
    ).toEqual(['HIGH_OCCLUSION']);
    expect(gatingCropWarnings(['UNKNOWN_GEOMETRY'])).toEqual([]);
  });
});

describe('safeFusionSummary', () => {
  const run = (evidence: unknown) => ({
    createdAt: new Date('2026-08-24T10:00:00Z'),
    policy: 'NEEDS_VLM',
    evidence,
  });

  const fullEvidence = {
    detector: { adapterKey: 'classical', warnings: [], yoloReady: false },
    cropArtifactId: 'artifact-auto-1',
    crops: [
      {
        phase: 'peak',
        timestampMs: 1500,
        box: { x: 120, y: 80, width: 160, height: 200 },
        quality: { sharpness: 1.9, occlusion: 0.55, brightness: 90 },
        selected: true,
      },
    ],
    fused: [{ sku: 'WATER-BOTTLE-500ML', fusedScore: 0.44, rank: 1 }],
    vlm: {
      invoked: true,
      status: 'VERDICT',
      verdict: 'AMBIGUOUS',
      selectedSku: null,
      visualSupport: 'WEAK',
      reasonCodes: ['LOW_VISUAL_MATCH', 'not a code: C:/path', 'OCCLUDED'],
      requiresHumanReview: true,
    },
    barcode: {
      results: [{ value: '5901234123457', format: 'EAN13' }],
      matchedSku: null,
    },
    ocr: {
      rawText: 'RAW-FRAME-TEXT-MUST-NOT-LEAK',
      normalizedText: 'normalized-must-not-leak',
      status: 'TIMEOUT',
    },
    inventoryValidation: [
      { sku: 'SKU-LIME-GREEN', verdict: 'NOT_STOCKED', onHandQuantity: 0 },
    ],
    stages: [{ stage: 'decode', note: 'C:/secret/path/leak.mp4' }],
  };

  it('extracts only the allowlisted fields and derives crop warnings', () => {
    const summary = safeFusionSummary(run(fullEvidence), 'SKU-LIME-GREEN', DIMS);
    expect(summary.topSku).toBe('WATER-BOTTLE-500ML');
    expect(summary.topScore).toBe(0.44);
    expect(summary.yoloReady).toBe(false);
    expect(summary.cropSource).toBe('AUTO');
    expect(summary.cropArtifactId).toBe('artifact-auto-1');
    expect(summary.vlmVerdict).toBe('AMBIGUOUS');
    expect(summary.vlmVisualSupport).toBe('WEAK');
    expect(summary.vlmReasonCodes).toEqual(['LOW_VISUAL_MATCH', 'OCCLUDED']);
    expect(summary.vlmRequiresHumanReview).toBe(true);
    expect(summary.barcodeMatchedSku).toBeNull();
    expect(summary.ocrStatus).toBe('TIMEOUT');
    expect(summary.expectedSkuInventoryVerdict).toBe('NOT_STOCKED');
    expect(summary.selectedCrop?.occlusion).toBe(0.55);
    expect(summary.cropWarnings).toContain('HIGH_OCCLUSION');
    expect(summary.cropWarnings).toContain('LOW_SHARPNESS');
  });

  it('NEVER leaks OCR text, barcode decode values, or path-like strings', () => {
    const serialized = JSON.stringify(
      safeFusionSummary(run(fullEvidence), 'SKU-LIME-GREEN', DIMS),
    );
    expect(serialized).not.toContain('RAW-FRAME-TEXT-MUST-NOT-LEAK');
    expect(serialized).not.toContain('normalized-must-not-leak');
    expect(serialized).not.toContain('5901234123457');
    expect(serialized).not.toContain('secret/path');
    expect(serialized).not.toContain('C:/path');
    expect(serialized).not.toContain('storageKey');
  });

  it('tolerates malformed or empty evidence without throwing', () => {
    for (const evidence of [null, undefined, 42, 'text', [], {}, { crops: 'x' }]) {
      const summary = safeFusionSummary(run(evidence), 'SKU-A', DIMS);
      expect(summary.topSku).toBeNull();
      expect(summary.selectedCrop).toBeNull();
      expect(summary.cropWarnings).toEqual(['NO_CLEAR_PRODUCT_FRAME']);
    }
  });
});

describe('applyOperatorCrop', () => {
  const base: SafeFusionSummary = {
    createdAt: new Date('2026-08-24T10:00:00Z'),
    policy: 'NEEDS_VLM',
    topSku: 'SKU-A',
    topScore: 0.4,
    yoloReady: false,
    cropSource: 'AUTO',
    cropArtifactId: 'artifact-auto-1',
    vlmInvoked: false,
    vlmStatus: null,
    vlmVerdict: null,
    vlmSelectedSku: null,
    vlmVisualSupport: null,
    vlmReasonCodes: [],
    vlmRequiresHumanReview: null,
    barcodeMatchedSku: null,
    ocrStatus: 'OK',
    expectedSkuInventoryVerdict: null,
    selectedCrop: { ...cleanCrop, sharpness: 1.2, occlusion: 0.6 },
    cropWarnings: ['HIGH_OCCLUSION', 'LOW_SHARPNESS', 'NO_CLEAR_PRODUCT_FRAME'],
  };
  const native = { width: 1920, height: 1080 };

  it('supersedes the auto crop as the clip evidence', () => {
    const applied = applyOperatorCrop(
      base,
      {
        artifactId: 'artifact-manual-1',
        timestampMs: 2100,
        box: { x: 600, y: 300, width: 500, height: 600 },
        createdAt: new Date('2026-08-24T11:00:00Z'),
      },
      native,
    );
    expect(applied.cropSource).toBe('OPERATOR');
    expect(applied.cropArtifactId).toBe('artifact-manual-1');
    expect(applied.selectedCrop?.phase).toBe('operator');
    expect(applied.selectedCrop?.qualityKnown).toBe(false);
    // The observed-failure warnings are gone: the operator visually
    // confirmed this crop and its geometry is valid.
    expect(applied.cropWarnings).toEqual([]);
  });

  it('still applies geometric checks in NATIVE space', () => {
    const applied = applyOperatorCrop(
      base,
      {
        artifactId: 'artifact-manual-2',
        timestampMs: 2100,
        box: { x: 1900, y: 1000, width: 500, height: 600 },
        createdAt: new Date(),
      },
      native,
    );
    expect(applied.cropWarnings).toEqual(['CROP_MISALIGNED']);
  });

  it('reports UNKNOWN_GEOMETRY when native dims are unknown', () => {
    const applied = applyOperatorCrop(
      base,
      {
        artifactId: 'artifact-manual-3',
        timestampMs: 2100,
        box: { x: 10, y: 10, width: 200, height: 200 },
        createdAt: new Date(),
      },
      null,
    );
    expect(applied.cropWarnings).toEqual(['UNKNOWN_GEOMETRY']);
  });
});

describe('deriveFailureReasons', () => {
  const summary = (over: Record<string, unknown>) => ({
    fusion: {
      createdAt: new Date(),
      policy: 'NEEDS_VLM',
      topSku: null,
      topScore: null,
      yoloReady: false,
      cropSource: 'AUTO',
      cropArtifactId: null,
      vlmInvoked: true,
      vlmStatus: 'VERDICT',
      vlmVerdict: null,
      vlmSelectedSku: null,
      vlmVisualSupport: null,
      vlmReasonCodes: [],
      vlmRequiresHumanReview: null,
      barcodeMatchedSku: 'SKU-A',
      ocrStatus: 'OK',
      expectedSkuInventoryVerdict: null,
      selectedCrop: null,
      cropWarnings: [],
      ...over,
    } as never,
  });

  it('rolls up the common failure reasons, most frequent first', () => {
    const reasons = deriveFailureReasons(
      [
        summary({ vlmVerdict: 'AMBIGUOUS' }),
        summary({ cropWarnings: ['HIGH_OCCLUSION', 'LOW_SHARPNESS'] }),
        summary({ cropWarnings: ['HIGH_OCCLUSION'] }),
        summary({ expectedSkuInventoryVerdict: 'NOT_STOCKED' }),
        summary({ barcodeMatchedSku: null, ocrStatus: 'TIMEOUT' }),
        { fusion: null, missedPositiveEvent: true },
        { fusion: null },
      ],
      { inferenceReady: false },
    );
    const byReason = Object.fromEntries(
      reasons.map((entry) => [entry.reason, entry.count]),
    );
    expect(byReason).toEqual({
      AMBIGUOUS_CROP: 1,
      HIGH_OCCLUSION: 2,
      BACKGROUND_HEAVY_CROP: 1,
      NOT_STOCKED: 1,
      NO_BARCODE_OCR: 1,
      MISSING_REFERENCES: 1,
      MISSED_POSITIVE_EVENT: 1,
    });
    expect(reasons[0].reason).toBe('HIGH_OCCLUSION');
  });

  it('reports nothing for a healthy SKU', () => {
    expect(deriveFailureReasons([], { inferenceReady: true })).toEqual([]);
  });
});

describe('evaluateGates', () => {
  const healthyFusion: SafeFusionSummary = {
    createdAt: new Date(),
    policy: 'AUTO_PROPOSE',
    topSku: 'SKU-A',
    topScore: 0.7,
    yoloReady: false,
    cropSource: 'AUTO',
    cropArtifactId: 'artifact-1',
    vlmInvoked: false,
    vlmStatus: null,
    vlmVerdict: null,
    vlmSelectedSku: null,
    vlmVisualSupport: null,
    vlmReasonCodes: [],
    vlmRequiresHumanReview: null,
    barcodeMatchedSku: null,
    ocrStatus: 'OK',
    expectedSkuInventoryVerdict: 'PLAUSIBLE',
    selectedCrop: cleanCrop,
    cropWarnings: [],
  };
  const healthy = {
    referenceCount: 9,
    minRequiredReferences: 5,
    embeddingCount: 9,
    stockedQuantity: 12,
    latestFusion: healthyFusion,
    reviewedPickupExamples: 5,
    reviewedReturnExamples: 2,
    reviewedFalseTouchExamples: 2,
    unreviewedClips: 0,
    linkedEvaluationReviewCount: 7,
  };

  it('is ready when every required gate passes', () => {
    const gates = evaluateGates(healthy);
    expect(gates.readyForDatasetImprovement).toBe(true);
    expect(gates.items.every((item) => !item.required || item.satisfied)).toBe(
      true,
    );
  });

  it('treats the 8-image recommendation as advisory only', () => {
    const gates = evaluateGates({ ...healthy, referenceCount: 6, embeddingCount: 6 });
    const recommended = gates.items.find(
      (item) => item.key === 'REFERENCES_RECOMMENDED',
    );
    expect(recommended?.satisfied).toBe(false);
    expect(recommended?.required).toBe(false);
    expect(gates.readyForDatasetImprovement).toBe(true);
  });

  it.each([
    ['referenceCount', { referenceCount: 4 }],
    ['embeddingCount', { embeddingCount: 3 }],
    ['stockedQuantity', { stockedQuantity: 0 }],
    ['latestFusion', { latestFusion: null }],
    ['reviewedPickupExamples', { reviewedPickupExamples: 4 }],
    ['reviewedReturnExamples', { reviewedReturnExamples: 1 }],
    ['reviewedFalseTouchExamples', { reviewedFalseTouchExamples: 1 }],
    ['unreviewedClips', { unreviewedClips: 2 }],
    ['linkedEvaluationReviewCount null', { linkedEvaluationReviewCount: null }],
    ['linkedEvaluationReviewCount 0', { linkedEvaluationReviewCount: 0 }],
  ])('is not ready when %s falls short', (_field, override) => {
    expect(
      evaluateGates({ ...healthy, ...override }).readyForDatasetImprovement,
    ).toBe(false);
  });

  it('fails the clean-crop gate while the latest crop carries gating warnings', () => {
    const gates = evaluateGates({
      ...healthy,
      latestFusion: {
        ...healthyFusion,
        cropWarnings: ['HIGH_OCCLUSION', 'LOW_SHARPNESS'],
      },
    });
    const crop = gates.items.find((item) => item.key === 'CLEAN_CROP');
    expect(crop?.satisfied).toBe(false);
    expect(crop?.detail).toContain('HIGH_OCCLUSION');
    expect(gates.readyForDatasetImprovement).toBe(false);
  });

  it('does not fail CLEAN_CROP on the advisory UNKNOWN_GEOMETRY warning', () => {
    const gates = evaluateGates({
      ...healthy,
      latestFusion: { ...healthyFusion, cropWarnings: ['UNKNOWN_GEOMETRY'] },
    });
    const crop = gates.items.find((item) => item.key === 'CLEAN_CROP');
    expect(crop?.satisfied).toBe(true);
    expect(crop?.detail).toContain('UNKNOWN_GEOMETRY');
  });

  it('CLEAN_CROP can pass on a valid operator-selected crop', () => {
    const gates = evaluateGates({
      ...healthy,
      latestFusion: {
        ...healthyFusion,
        cropSource: 'OPERATOR',
        selectedCrop: { ...cleanCrop, phase: 'operator', qualityKnown: false },
        cropWarnings: [],
      },
    });
    const crop = gates.items.find((item) => item.key === 'CLEAN_CROP');
    expect(crop?.satisfied).toBe(true);
    expect(crop?.detail).toContain('operator-selected');
  });
});
