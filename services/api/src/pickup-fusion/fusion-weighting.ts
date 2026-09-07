import { cellFromNormalized } from '../planogram/planogram.logic';
import { CandidateSignal } from './ports';

/**
 * PURE fusion weighting (no Nest, no I/O) shared by the weighted-sum
 * fusion adapter and the orchestration service's evidence.
 *
 * Base weights — configuration, not calibration. The set sums to 1.0 and
 * is chosen so the SIGNAL CLASSES can reach the default auto threshold
 * (0.42) in the combinations the policy intends: a catalog-matched barcode
 * plus any support clears it; agreement of both visual signals with a
 * matching planogram cell clears it narrowly; a single strong signal
 * cannot.
 *
 *   barcode   0.30   classical 0.18   retrieval 0.18
 *   ocr       0.12   context   0.07   planogram 0.15
 *
 * AVAILABLE-SIGNAL RENORMALIZATION. A shelf camera rarely reads a barcode
 * or text, so a visual-only pickup used to be capped at the sum of the
 * visual weights (0.52 under the old table) no matter how strongly its
 * signals agreed. For each event the classes that produced NO signal at
 * all are marked unavailable and the remaining weights are renormalized to
 * sum to 1, then the fused score is multiplied by a COVERAGE FACTOR
 *
 *   coverage = sqrt( sum of the BASE weights of the available IDENTITY
 *                    classes: barcode, classical, retrieval, ocr, planogram )
 *
 * Context is a prior over whatever candidates exist, so it never counts
 * toward coverage — otherwise one strong classical match plus "in stock"
 * would impersonate corroboration. Worked examples (context 0.8):
 *   classical 0.95 alone            → 0.72·0.95 + 0.28·0.8 = 0.908 × √0.18 = 0.385  (below 0.42)
 *   barcode 1.0 alone               → 0.81·1.0 + 0.19·0.8 = 0.962 × √0.30 = 0.527  (clears)
 *   classical 0.34 + retrieval 0.45 → 0.46 × √0.36 = 0.276                          (below)
 *   … + planogram cell 1.0          → 0.60 × √0.51 = 0.429                          (clears narrowly)
 */
export const FUSION_WEIGHTS = {
  barcode: 0.3,
  classical: 0.18,
  retrieval: 0.18,
  ocr: 0.12,
  context: 0.07,
  planogram: 0.15,
} as const;

export type FusionSignalClass = keyof typeof FUSION_WEIGHTS;

export const FUSION_SIGNAL_CLASSES: readonly FusionSignalClass[] = [
  'barcode',
  'classical',
  'retrieval',
  'ocr',
  'context',
  'planogram',
];

export interface FusionInputs {
  classical: CandidateSignal[];
  retrieval: CandidateSignal[];
  barcode: CandidateSignal[];
  ocr: CandidateSignal[];
  context: CandidateSignal[];
  /** Phase 22/23 planogram signal. `null`/undefined = no rack bound (class
   *  unavailable); an array — even one of zeros — means the rack was
   *  consulted. */
  planogram?: CandidateSignal[] | null;
}

export interface FusionWeighting {
  available: FusionSignalClass[];
  unavailable: FusionSignalClass[];
  /** Effective (renormalized) weight per class; 0 for unavailable classes. */
  weights: Record<FusionSignalClass, number>;
  /** sqrt(sum of base weights of the available classes), 0..1. */
  coverage: number;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Which classes produced ANY signal for this event. Context is never
 * unavailable (it is a prior over whatever candidates exist); planogram is
 * available exactly when the caller consulted a bound rack.
 */
export function availableSignalClasses(inputs: FusionInputs): Set<FusionSignalClass> {
  const available = new Set<FusionSignalClass>(['context']);
  if (inputs.barcode.length > 0) available.add('barcode');
  if (inputs.classical.length > 0) available.add('classical');
  if (inputs.retrieval.length > 0) available.add('retrieval');
  if (inputs.ocr.length > 0) available.add('ocr');
  if (inputs.planogram !== null && inputs.planogram !== undefined) available.add('planogram');
  return available;
}

/** Classes that IDENTIFY a product (count toward coverage); context is a prior. */
export const IDENTITY_SIGNAL_CLASSES: readonly FusionSignalClass[] = [
  'barcode',
  'classical',
  'retrieval',
  'ocr',
  'planogram',
];

/** Renormalized weights + coverage factor for a set of available classes. */
export function effectiveWeights(available: Set<FusionSignalClass>): FusionWeighting {
  let baseSum = 0;
  let identitySum = 0;
  for (const source of FUSION_SIGNAL_CLASSES) {
    if (available.has(source)) {
      baseSum += FUSION_WEIGHTS[source];
      if (IDENTITY_SIGNAL_CLASSES.includes(source)) identitySum += FUSION_WEIGHTS[source];
    }
  }
  const weights = {} as Record<FusionSignalClass, number>;
  for (const source of FUSION_SIGNAL_CLASSES) {
    weights[source] =
      available.has(source) && baseSum > 0 ? round4(FUSION_WEIGHTS[source] / baseSum) : 0;
  }
  return {
    available: FUSION_SIGNAL_CLASSES.filter((source) => available.has(source)),
    unavailable: FUSION_SIGNAL_CLASSES.filter((source) => !available.has(source)),
    weights,
    coverage: round4(Math.sqrt(identitySum)),
  };
}

// ------------------------------------------------------------ planogram

export interface PlanogramRackLayout {
  rackCode: string;
  rows: number;
  columns: number;
  cells: { productId: string; rowIndex: number; columnIndex: number; cellCode: string }[];
}

/** Score in the planogram signal for a product assigned to the event cell. */
export const PLANOGRAM_CELL_SCORE = 1;
/** Score for a product assigned elsewhere on the bound rack. */
export const PLANOGRAM_RACK_SCORE = 0.6;

/**
 * Map the event's normalized ANALYSIS-FRAME point through the rack's
 * frame region (normalized rectangle; null = the rack fills the frame)
 * into rack coordinates. Returns null when the point lies outside the
 * region — the event happened off the rack.
 */
export function rackPointFor(
  framePoint: { x: number; y: number },
  region: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number } | null {
  const area = region ?? { x: 0, y: 0, width: 1, height: 1 };
  if (area.width <= 0 || area.height <= 0) {
    return null;
  }
  const x = (framePoint.x - area.x) / area.width;
  const y = (framePoint.y - area.y) / area.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

/**
 * The planogram SIGNAL: 1.0 for a candidate assigned to the cell the
 * event maps to, 0.6 for a candidate assigned anywhere on the rack, 0 for
 * the rest. Without a rack point every rack SKU scores at the rack level.
 * Pure; the caller decides whether a rack is bound at all.
 */
export function planogramSignalsFor(
  candidates: { productId: string; sku: string }[],
  rack: PlanogramRackLayout,
  rackPoint: { x: number; y: number } | null,
): { signals: CandidateSignal[]; cellCode: string | null } {
  const cell =
    rackPoint === null ? null : cellFromNormalized(rack.rows, rack.columns, rackPoint.x, rackPoint.y);
  const cellProducts = new Set(
    cell === null ? [] : rack.cells.filter((row) => row.cellCode === cell.cellCode).map((row) => row.productId),
  );
  const rackProducts = new Set(rack.cells.map((row) => row.productId));
  const signals = candidates.map((candidate) => {
    if (cellProducts.has(candidate.productId)) {
      return {
        productId: candidate.productId,
        sku: candidate.sku,
        score: PLANOGRAM_CELL_SCORE,
        detail: `planogram:cell(${cell!.cellCode})`,
      };
    }
    if (rackProducts.has(candidate.productId)) {
      return {
        productId: candidate.productId,
        sku: candidate.sku,
        score: PLANOGRAM_RACK_SCORE,
        detail: 'planogram:rack',
      };
    }
    return { productId: candidate.productId, sku: candidate.sku, score: 0, detail: 'planogram:off-rack' };
  });
  return { signals, cellCode: cell?.cellCode ?? null };
}
