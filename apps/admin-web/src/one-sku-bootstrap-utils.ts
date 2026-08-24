/**
 * One-SKU bootstrap — pure page logic, unit-tested in
 * one-sku-bootstrap.spec.ts (the repo convention: pages hold JSX, logic
 * lives in a sibling utils file).
 */

export function oneSkuReportPath(productId: string): string {
  return `/one-sku-bootstrap/${encodeURIComponent(productId)}/report`;
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
  HIGH_OCCLUSION: 'Hand covers too much of the product',
  LOW_SHARPNESS: 'Crop is blurry',
  CROP_MISALIGNED: 'Crop box misaligned',
  NO_CLEAR_PRODUCT_FRAME: 'No clear product view in any frame',
};

export const FAILURE_REASON_LABELS: Record<string, string> = {
  AMBIGUOUS_CROP: 'VLM found the crop ambiguous',
  HIGH_OCCLUSION: 'High occlusion in selected crop',
  NOT_STOCKED: 'Expected SKU not stocked in the store context',
  MISSING_REFERENCES: 'Reference library below minimum',
  NO_BARCODE_OCR: 'No barcode match and OCR did not complete',
  BACKGROUND_HEAVY_CROP: 'Selected crop is mostly background',
};

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
