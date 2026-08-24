/**
 * One-SKU bootstrap — PURE report derivations (no I/O, no Nest).
 *
 * The bootstrap page guides an operator through proving out ONE real SKU
 * (references → embeddings → stocked → clean test clips → reviewed
 * examples) before scaling to more. Everything here is guidance only:
 * gates never block any other workflow, and every number is derived from
 * rows the existing shadow pipeline already wrote.
 *
 * Evidence safety: `safeFusionSummary` extracts ONLY classified codes,
 * SKUs, and numbers from the persisted fusion evidence JSON — never OCR
 * text, barcode decode values, storage keys, or provider error text.
 */

// ------------------------------------------------------------ thresholds

/** Below this the library works but retrieval is weak — recommend more. */
export const RECOMMENDED_REFERENCE_IMAGES = 8;
/** Mean-gradient-energy sharpness below this is a blur/background crop
 *  (clean product crops in the fusion test fixtures score 20-30; the
 *  failing Nescafe crop scored 0.9-2.4). */
export const WEAK_SHARPNESS_THRESHOLD = 8;
/** Hand/motion overlap above this fraction hides too much product. */
export const HIGH_OCCLUSION_THRESHOLD = 0.3;
/** Selected crop should cover at least this fraction of the analysis frame. */
export const MIN_CROP_AREA_FRACTION = 0.02;

/** One-SKU dataset gates (guidance, mirrors the Phase 18 minimums). */
export const MIN_REVIEWED_PICKUPS = 5;
export const MIN_REVIEWED_RETURNS = 2;
export const MIN_REVIEWED_FALSE_TOUCHES = 2;

/** Newest-first cap on ground-truthed clips considered by the report. */
export const BOOTSTRAP_MAX_CLIPS = 100;

/** Mirrors PickupDetectionConfig.DEFAULT_ANALYSIS_WIDTH — crop boxes in
 *  fusion evidence are in this downscaled analysis geometry, NOT native
 *  video pixels. */
export const ANALYSIS_TARGET_WIDTH = 192;

export const SCORE_NOTE =
  'Scores are uncalibrated ranking signals, not probabilities; counts ' +
  'below describe operator-labeled test clips only — no accuracy claim.';

// ------------------------------------------------------------ types

export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafeCropSummary {
  phase: string;
  timestampMs: number;
  box: BoxLike;
  sharpness: number;
  occlusion: number;
  brightness: number;
  selected: boolean;
}

export type CropQualityWarning =
  | 'PRODUCT_TOO_SMALL'
  | 'HIGH_OCCLUSION'
  | 'LOW_SHARPNESS'
  | 'CROP_MISALIGNED'
  | 'NO_CLEAR_PRODUCT_FRAME';

export interface SafeFusionSummary {
  createdAt: Date;
  policy: string;
  topSku: string | null;
  topScore: number | null;
  yoloReady: boolean | null;
  vlmInvoked: boolean;
  vlmStatus: string | null;
  vlmVerdict: string | null;
  vlmSelectedSku: string | null;
  vlmRequiresHumanReview: boolean | null;
  barcodeMatchedSku: string | null;
  ocrStatus: string | null;
  /** Inventory verdict recorded for the given expected SKU (if any). */
  expectedSkuInventoryVerdict: string | null;
  selectedCrop: SafeCropSummary | null;
  cropWarnings: CropQualityWarning[];
}

export type BootstrapFailureReason =
  | 'AMBIGUOUS_CROP'
  | 'HIGH_OCCLUSION'
  | 'NOT_STOCKED'
  | 'MISSING_REFERENCES'
  | 'NO_BARCODE_OCR'
  | 'BACKGROUND_HEAVY_CROP';

export interface GateItem {
  key: string;
  label: string;
  satisfied: boolean;
  /** Advisory items never hold back readiness. */
  required: boolean;
  detail: string;
}

// ------------------------------------------------------------ geometry

/** Mirror of analysisGeometryFor's math (even dims, min 16) so crop box
 *  area can be compared against the SAME frame the box lives in. */
export function analysisDimsFor(
  native: { width: number | null; height: number | null } | null,
): { width: number; height: number } | null {
  if (!native || !native.width || !native.height) {
    return null;
  }
  const width = Math.max(16, Math.min(ANALYSIS_TARGET_WIDTH, native.width));
  const evenWidth = width - (width % 2);
  const scaledHeight = Math.round((native.height * evenWidth) / native.width);
  const evenHeight = Math.max(16, scaledHeight - (scaledHeight % 2));
  return { width: evenWidth, height: evenHeight };
}

// ------------------------------------------------------------ crop QA

/** Classify why a selected crop is weak evidence. Pure guidance — the
 *  same clip still flows through every existing pipeline unchanged. */
export function deriveCropWarnings(
  selected: SafeCropSummary | null,
  analysisDims: { width: number; height: number } | null,
): CropQualityWarning[] {
  if (!selected) {
    return ['NO_CLEAR_PRODUCT_FRAME'];
  }
  const warnings: CropQualityWarning[] = [];
  const highOcclusion = selected.occlusion > HIGH_OCCLUSION_THRESHOLD;
  const lowSharpness = selected.sharpness < WEAK_SHARPNESS_THRESHOLD;
  if (highOcclusion) {
    warnings.push('HIGH_OCCLUSION');
  }
  if (lowSharpness) {
    warnings.push('LOW_SHARPNESS');
  }
  const box = selected.box;
  if (box.width <= 0 || box.height <= 0) {
    warnings.push('CROP_MISALIGNED');
  } else if (analysisDims) {
    const outOfFrame =
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > analysisDims.width ||
      box.y + box.height > analysisDims.height;
    if (outOfFrame) {
      warnings.push('CROP_MISALIGNED');
    }
    const areaFraction =
      (box.width * box.height) / (analysisDims.width * analysisDims.height);
    if (!outOfFrame && areaFraction < MIN_CROP_AREA_FRACTION) {
      warnings.push('PRODUCT_TOO_SMALL');
    }
  }
  // Blurry AND mostly hand/motion: the crop is effectively background —
  // exactly the observed failure (table crop, sharpness ~1, occlusion >50%).
  if (highOcclusion && lowSharpness) {
    warnings.push('NO_CLEAR_PRODUCT_FRAME');
  }
  return warnings;
}

// ------------------------------------------------- evidence extraction

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeCrop(value: unknown): SafeCropSummary | null {
  const crop = asRecord(value);
  if (!crop) {
    return null;
  }
  const quality = asRecord(crop.quality);
  const box = asRecord(crop.box);
  const x = num(box?.x);
  const y = num(box?.y);
  const width = num(box?.width);
  const height = num(box?.height);
  const timestampMs = num(crop.timestampMs);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    timestampMs === null
  ) {
    return null;
  }
  return {
    phase: str(crop.phase) ?? 'unknown',
    timestampMs,
    box: { x, y, width, height },
    sharpness: num(quality?.sharpness) ?? 0,
    occlusion: num(quality?.occlusion) ?? 0,
    brightness: num(quality?.brightness) ?? 0,
    selected: crop.selected === true,
  };
}

/**
 * Field-by-field allowlist extraction from the persisted fusion evidence
 * JSON. Anything not explicitly picked here (OCR raw/normalized text,
 * barcode decode values, VLM reason text, stage notes) NEVER reaches the
 * report response.
 */
export function safeFusionSummary(
  run: { createdAt: Date; policy: string; evidence: unknown },
  expectedSku: string | null,
  analysisDims: { width: number; height: number } | null,
): SafeFusionSummary {
  const evidence = asRecord(run.evidence);
  const detector = asRecord(evidence?.detector);
  const vlm = asRecord(evidence?.vlm);
  const barcode = asRecord(evidence?.barcode);
  const ocr = asRecord(evidence?.ocr);

  const fusedRaw = Array.isArray(evidence?.fused) ? evidence.fused : [];
  const top = asRecord(fusedRaw[0]);

  const cropsRaw = Array.isArray(evidence?.crops) ? evidence.crops : [];
  const crops = cropsRaw
    .map(safeCrop)
    .filter((crop): crop is SafeCropSummary => crop !== null);
  const selectedCrop = crops.find((crop) => crop.selected) ?? null;

  let expectedSkuInventoryVerdict: string | null = null;
  if (expectedSku) {
    const inventoryRaw = Array.isArray(evidence?.inventoryValidation)
      ? evidence.inventoryValidation
      : [];
    for (const entry of inventoryRaw) {
      const row = asRecord(entry);
      if (row && str(row.sku) === expectedSku) {
        expectedSkuInventoryVerdict = str(row.verdict);
        break;
      }
    }
  }

  return {
    createdAt: run.createdAt,
    policy: run.policy,
    topSku: str(top?.sku),
    topScore: num(top?.fusedScore),
    yoloReady: boolOrNull(detector?.yoloReady),
    vlmInvoked: vlm?.invoked === true,
    vlmStatus: str(vlm?.status),
    vlmVerdict: str(vlm?.verdict),
    vlmSelectedSku: str(vlm?.selectedSku),
    vlmRequiresHumanReview: boolOrNull(vlm?.requiresHumanReview),
    barcodeMatchedSku: str(barcode?.matchedSku),
    ocrStatus: str(ocr?.status),
    expectedSkuInventoryVerdict,
    selectedCrop,
    cropWarnings: deriveCropWarnings(selectedCrop, analysisDims),
  };
}

// ------------------------------------------------------ failure rollup

export function deriveFailureReasons(
  clips: { fusion: SafeFusionSummary | null }[],
  references: { inferenceReady: boolean },
): { reason: BootstrapFailureReason; count: number }[] {
  const counts = new Map<BootstrapFailureReason, number>();
  const bump = (reason: BootstrapFailureReason) =>
    counts.set(reason, (counts.get(reason) ?? 0) + 1);

  if (!references.inferenceReady) {
    bump('MISSING_REFERENCES');
  }
  for (const clip of clips) {
    const fusion = clip.fusion;
    if (!fusion) {
      continue;
    }
    if (fusion.vlmVerdict === 'AMBIGUOUS') {
      bump('AMBIGUOUS_CROP');
    }
    if (fusion.cropWarnings.includes('HIGH_OCCLUSION')) {
      bump('HIGH_OCCLUSION');
    }
    if (
      fusion.cropWarnings.includes('HIGH_OCCLUSION') &&
      fusion.cropWarnings.includes('LOW_SHARPNESS')
    ) {
      bump('BACKGROUND_HEAVY_CROP');
    }
    if (
      fusion.expectedSkuInventoryVerdict === 'NOT_STOCKED' ||
      fusion.expectedSkuInventoryVerdict === 'OUT_OF_STOCK'
    ) {
      bump('NOT_STOCKED');
    }
    if (fusion.barcodeMatchedSku === null && fusion.ocrStatus !== 'OK') {
      bump('NO_BARCODE_OCR');
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------------ gates

export interface GateInput {
  referenceCount: number;
  minRequiredReferences: number;
  embeddingCount: number;
  stockedQuantity: number;
  latestFusion: SafeFusionSummary | null;
  reviewedPickupExamples: number;
  reviewedReturnExamples: number;
  reviewedFalseTouchExamples: number;
  unreviewedClips: number;
}

/** The one-SKU checklist. Guidance only — nothing here blocks any
 *  existing endpoint or pipeline behavior. */
export function evaluateGates(input: GateInput): {
  items: GateItem[];
  readyForDatasetImprovement: boolean;
} {
  const items: GateItem[] = [
    {
      key: 'REFERENCES_MIN',
      label: `At least ${input.minRequiredReferences} reference images`,
      satisfied: input.referenceCount >= input.minRequiredReferences,
      required: true,
      detail: `${input.referenceCount} uploaded`,
    },
    {
      key: 'REFERENCES_RECOMMENDED',
      label: `${RECOMMENDED_REFERENCE_IMAGES}+ reference images recommended`,
      satisfied: input.referenceCount >= RECOMMENDED_REFERENCE_IMAGES,
      required: false,
      detail: `${input.referenceCount} uploaded`,
    },
    {
      key: 'EMBEDDINGS_BUILT',
      label: 'Embeddings built for every reference image',
      satisfied:
        input.referenceCount > 0 &&
        input.embeddingCount >= input.referenceCount,
      required: true,
      detail: `${input.embeddingCount}/${input.referenceCount} indexed`,
    },
    {
      key: 'INVENTORY_STOCKED',
      label: 'SKU stocked in at least one store (quantity > 0)',
      satisfied: input.stockedQuantity > 0,
      required: true,
      detail: `${input.stockedQuantity} on hand across stores`,
    },
    {
      key: 'CLEAN_CROP',
      label: 'Latest selected crop has no quality warnings',
      satisfied:
        input.latestFusion !== null &&
        input.latestFusion.cropWarnings.length === 0,
      required: true,
      detail: input.latestFusion
        ? input.latestFusion.cropWarnings.length === 0
          ? 'clean'
          : input.latestFusion.cropWarnings.join(', ')
        : 'no fusion run yet',
    },
    {
      key: 'PICKUP_EXAMPLES',
      label: `At least ${MIN_REVIEWED_PICKUPS} reviewed pickup examples`,
      satisfied: input.reviewedPickupExamples >= MIN_REVIEWED_PICKUPS,
      required: true,
      detail: `${input.reviewedPickupExamples} reviewed`,
    },
    {
      key: 'RETURN_EXAMPLES',
      label: `At least ${MIN_REVIEWED_RETURNS} reviewed return examples`,
      satisfied: input.reviewedReturnExamples >= MIN_REVIEWED_RETURNS,
      required: true,
      detail: `${input.reviewedReturnExamples} reviewed`,
    },
    {
      key: 'FALSE_TOUCH_EXAMPLES',
      label:
        `At least ${MIN_REVIEWED_FALSE_TOUCHES} reviewed false-touch ` +
        'examples (false-touch clips are tenant-wide: NONE ground truth ' +
        'carries no SKU)',
      satisfied:
        input.reviewedFalseTouchExamples >= MIN_REVIEWED_FALSE_TOUCHES,
      required: true,
      detail: `${input.reviewedFalseTouchExamples} reviewed`,
    },
    {
      key: 'ALL_REVIEWED',
      label: 'Every ground-truthed clip reviewed or corrected',
      satisfied: input.unreviewedClips === 0,
      required: true,
      detail:
        input.unreviewedClips === 0
          ? 'all reviewed'
          : `${input.unreviewedClips} awaiting review`,
    },
  ];
  return {
    items,
    readyForDatasetImprovement: items
      .filter((item) => item.required)
      .every((item) => item.satisfied),
  };
}
