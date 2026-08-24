/**
 * One-SKU bootstrap — pure page logic, unit-tested in
 * one-sku-bootstrap.spec.ts (the repo convention: pages hold JSX, logic
 * lives in a sibling utils file).
 */

export function oneSkuReportPath(productId: string): string {
  return `/one-sku-bootstrap/${encodeURIComponent(productId)}/report`;
}

export function oneSkuEvaluationRunPath(productId: string): string {
  return `/one-sku-bootstrap/${encodeURIComponent(productId)}/evaluation-run`;
}

/** The RECORD-ONLY bootstrap correction endpoint (pilot review via the
 *  API's delegating route) — never the vision-event review path, whose
 *  APPROVE/OVERRIDE handling can mutate checkout basket lines. */
export function oneSkuReviewPath(
  productId: string,
  videoAssetId: string,
): string {
  return (
    `/one-sku-bootstrap/${encodeURIComponent(productId)}` +
    `/videos/${encodeURIComponent(videoAssetId)}/review`
  );
}

/** Recommended capture angles for a bootstrap reference library. Purely
 *  operator guidance — images are not angle-labeled anywhere. */
export const REFERENCE_ANGLES: { key: string; label: string }[] = [
  { key: 'front', label: 'Front label' },
  { key: 'left', label: 'Left angle' },
  { key: 'right', label: 'Right angle' },
  { key: 'back', label: 'Back / barcode' },
  { key: 'top', label: 'Top' },
  { key: 'shelf', label: 'On shelf / table' },
  { key: 'hand', label: 'In hand' },
];

export const CROP_WARNING_LABELS: Record<string, string> = {
  PRODUCT_TOO_SMALL: 'Product too small in frame',
  HIGH_OCCLUSION: 'Hand covers the product',
  LOW_SHARPNESS: 'Crop is blurry',
  CROP_MISALIGNED: 'Crop box misaligned',
  NO_CLEAR_PRODUCT_FRAME: 'Crop is mostly background',
  UNKNOWN_GEOMETRY: 'Frame size unknown — alignment unverified',
};

export const FAILURE_REASON_LABELS: Record<string, string> = {
  AMBIGUOUS_CROP: 'VLM found the crop ambiguous',
  HIGH_OCCLUSION: 'High occlusion in selected crop',
  NOT_STOCKED: 'Expected SKU not stocked in the store context',
  MISSING_REFERENCES: 'Reference library below minimum',
  NO_BARCODE_OCR: 'No barcode match and OCR did not complete',
  BACKGROUND_HEAVY_CROP: 'Selected crop is mostly background',
  MISSED_POSITIVE_EVENT: 'Missing positive event (pickup/return not detected)',
};

// ------------------------------------------------ workflow status/CTA

/** The minimal report slice the header/next-action helpers read — keeps
 *  them pure and testable without the full report type. */
export interface ReportSlice {
  references: {
    referenceCount: number;
    minRequired: number;
    inferenceReady: boolean;
    embeddingCount: number;
    embeddingsBuilt: boolean;
  };
  inventory: { stocked: boolean };
  counts: {
    totalClips: number;
    reviewedPickupExamples: number;
    reviewedReturnExamples: number;
    reviewedFalseTouchExamples: number;
    unreviewedClips: number;
  };
  latest: unknown | null;
  videos: { fusion: { cropWarnings: string[] } | null }[];
  linkedEvaluationRun: { reviewCount: number } | null;
  gates: {
    items: { key: string; satisfied: boolean; required: boolean }[];
    readyForDatasetImprovement: boolean;
  };
}

export interface StatusChip {
  key: string;
  label: string;
  tone: 'ok' | 'warn' | 'down';
  detail: string;
}

function gateSatisfied(report: ReportSlice, key: string): boolean {
  return (
    report.gates.items.find((item) => item.key === key)?.satisfied === true
  );
}

/** The five headline chips of the guided workflow. */
export function deriveStatusHeader(report: ReportSlice): StatusChip[] {
  const referencesReady =
    report.references.inferenceReady && report.references.embeddingsBuilt;
  const cropClean = gateSatisfied(report, 'CLEAN_CROP');
  const evidenceReady =
    report.counts.totalClips > 0 && report.counts.unreviewedClips === 0;
  return [
    {
      key: 'references',
      label: 'References',
      tone: referencesReady ? 'ok' : 'down',
      detail: referencesReady
        ? `${report.references.referenceCount} images indexed`
        : `${report.references.referenceCount}/${report.references.minRequired} images · ${report.references.embeddingCount} embedded`,
    },
    {
      key: 'inventory',
      label: 'Inventory',
      tone: report.inventory.stocked ? 'ok' : 'warn',
      detail: report.inventory.stocked ? 'stocked' : 'not stocked',
    },
    {
      key: 'evidence',
      label: 'Video evidence',
      tone:
        report.counts.totalClips === 0
          ? 'down'
          : evidenceReady
            ? 'ok'
            : 'warn',
      detail:
        report.counts.totalClips === 0
          ? 'no test clips yet'
          : evidenceReady
            ? `${report.counts.totalClips} clips reviewed`
            : `${report.counts.unreviewedClips} need review`,
    },
    {
      key: 'crop',
      label: 'Crop quality',
      tone: report.latest === null ? 'down' : cropClean ? 'ok' : 'warn',
      detail:
        report.latest === null
          ? 'no fusion run yet'
          : cropClean
            ? 'clean'
            : 'needs manual crop',
    },
    {
      key: 'dataset',
      label: 'Dataset improvement',
      tone: report.gates.readyForDatasetImprovement ? 'ok' : 'warn',
      detail: report.gates.readyForDatasetImprovement
        ? 'ready'
        : 'not ready',
    },
  ];
}

/** The single next-best action the operator should take, in priority
 *  order of the guided workflow. */
export function nextBestAction(report: ReportSlice): {
  key: string;
  label: string;
} {
  if (report.references.referenceCount < report.references.minRequired) {
    return {
      key: 'UPLOAD_REFERENCES',
      label: `Upload reference images (${report.references.referenceCount}/${report.references.minRequired})`,
    };
  }
  if (!report.references.embeddingsBuilt) {
    return {
      key: 'BUILD_EMBEDDINGS',
      label: 'Rebuild embeddings so retrieval uses your reference images',
    };
  }
  if (!report.inventory.stocked) {
    return {
      key: 'STOCK_SKU',
      label: 'Stock the SKU in a store (Inventory page) so fusion can validate it',
    };
  }
  if (report.counts.totalClips === 0) {
    return {
      key: 'UPLOAD_CLIP',
      label: 'Upload a first test video and set its ground truth',
    };
  }
  if (!gateSatisfied(report, 'CLEAN_CROP')) {
    return {
      key: 'FIX_CROP',
      label:
        'Fix crop quality: recapture with the product clearly visible, or draw a manual crop',
    };
  }
  if (report.counts.unreviewedClips > 0) {
    return {
      key: 'REVIEW_CLIPS',
      label: `Review the ${report.counts.unreviewedClips} unreviewed clip(s)`,
    };
  }
  if (
    !gateSatisfied(report, 'PICKUP_EXAMPLES') ||
    !gateSatisfied(report, 'RETURN_EXAMPLES') ||
    !gateSatisfied(report, 'FALSE_TOUCH_EXAMPLES')
  ) {
    return {
      key: 'MORE_EXAMPLES',
      label: 'Record more examples (5 pickups, 2 returns, 2 false touches)',
    };
  }
  if (!gateSatisfied(report, 'EVALUATION_RUN_LINKED')) {
    return {
      key: 'LINK_EVALUATION_RUN',
      label:
        'Record corrections into the bootstrap evaluation run so Phase 18 can read them',
    };
  }
  return {
    key: 'SEND_TO_DATASET',
    label: 'Send reviewed examples to Dataset Improvement',
  };
}

/** '+2' pickup, '−1' return, '0' false touch — display only. */
export function basketDeltaLabel(delta: number): string {
  if (delta > 0) {
    return `+${delta}`;
  }
  if (delta < 0) {
    return `−${Math.abs(delta)}`;
  }
  return '0';
}

// ------------------------------------------------------ manual crop

/** The ONLY reasons a crop may carry — the server's closed enum. Free
 *  text (and with it paths/URLs/credentials) is unrepresentable. */
export const MANUAL_CROP_REASONS = [
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'SHELF_AUDIT',
  'CART_INSERTION',
  'OCR_REVIEW',
  'VLM_REVIEW',
] as const;

export interface ManualCropDraft {
  timestampMs: string;
  x: string;
  y: string;
  width: string;
  height: string;
  reason: string;
}

export interface ManualCropPayload {
  timestampMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: (typeof MANUAL_CROP_REASONS)[number];
}

export type ManualCropFieldErrors = Partial<
  Record<keyof ManualCropDraft, string>
>;

function parseNonNegativeInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Strict manual-crop validation. Every field must be a plain non-negative
 * integer (never `Number('') === 0` fallbacks), the reason must come from
 * the closed enum, and the returned payload contains EXACTLY the numeric
 * fields plus the optional enum reason — there is no field free text,
 * paths, or source references could travel in.
 */
export function validateManualCrop(
  draft: ManualCropDraft,
  durationMs: number | null,
):
  | { ok: true; payload: ManualCropPayload }
  | { ok: false; errors: ManualCropFieldErrors } {
  const errors: ManualCropFieldErrors = {};
  const timestampMs = parseNonNegativeInt(draft.timestampMs);
  if (
    timestampMs === null ||
    (durationMs !== null && timestampMs >= durationMs)
  ) {
    errors.timestampMs =
      durationMs !== null
        ? `Timestamp must be between 0 and ${durationMs - 1} ms.`
        : 'Timestamp must be a non-negative integer of milliseconds.';
  }
  const x = parseNonNegativeInt(draft.x);
  if (x === null) {
    errors.x = 'x must be a non-negative integer pixel offset.';
  }
  const y = parseNonNegativeInt(draft.y);
  if (y === null) {
    errors.y = 'y must be a non-negative integer pixel offset.';
  }
  const width = parseNonNegativeInt(draft.width);
  if (width === null || width < 1) {
    errors.width = 'Width must be a positive integer pixel size.';
  }
  const height = parseNonNegativeInt(draft.height);
  if (height === null || height < 1) {
    errors.height = 'Height must be a positive integer pixel size.';
  }
  const reason = draft.reason.trim();
  if (
    reason !== '' &&
    !(MANUAL_CROP_REASONS as readonly string[]).includes(reason)
  ) {
    errors.reason = 'Reason must be one of the listed crop reasons.';
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    payload: {
      timestampMs: timestampMs as number,
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
      ...(reason === ''
        ? {}
        : { reason: reason as (typeof MANUAL_CROP_REASONS)[number] }),
    },
  };
}

/** Percent-based overlay rectangle for previewing a crop box over an
 *  extracted frame image (box and frame share native pixel space). */
export function overlayRectStyle(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): { left: string; top: string; width: string; height: string } | null {
  if (frame.width <= 0 || frame.height <= 0) {
    return null;
  }
  const pct = (value: number, total: number) =>
    `${Math.max(0, Math.min(100, (value / total) * 100)).toFixed(2)}%`;
  return {
    left: pct(box.x, frame.width),
    top: pct(box.y, frame.height),
    width: pct(box.width, frame.width),
    height: pct(box.height, frame.height),
  };
}

/** Progress over REQUIRED gates only (advisory items don't count). */
export function gateProgress(
  items: { satisfied: boolean; required: boolean }[],
): { satisfied: number; total: number } {
  const required = items.filter((item) => item.required);
  return {
    satisfied: required.filter((item) => item.satisfied).length,
    total: required.length,
  };
}
