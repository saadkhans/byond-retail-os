/**
 * Phase 19 — planogram cell math and SOFT SKU-narrowing priors.
 * PURE derivations (no I/O, no Nest).
 *
 * A planogram is EVIDENCE, never a lock: it re-orders and boosts SKU
 * candidates and flags disagreement for human review — it never rejects
 * a SKU outright, and nothing derived here mutates checkout, order,
 * payment, settlement, or inventory state.
 */

// ------------------------------------------------------------ constants

/** Below this cell-assignment confidence the cell is treated as UNKNOWN
 *  and narrowing falls back to the whole rack (then the full catalog). */
export const CELL_CONFIDENCE_FLOOR = 0.2;

/** Soft score boosts (scaled by cell confidence where noted). Small by
 *  design: a strong visual score must stay able to beat the prior. */
export const CELL_PRIOR_BOOST = 0.15;
export const ADJACENT_PRIOR_BOOST = 0.08;
export const RACK_PRIOR_BOOST = 0.04;

export const MAX_PLANOGRAM_ROWS = 26; // row letters A..Z
export const MAX_PLANOGRAM_COLUMNS = 99;

export type PlanogramMatchStatus =
  | 'MATCH'
  | 'ADJACENT_MATCH'
  | 'RACK_MATCH'
  | 'OUT_OF_PLANOGRAM'
  | 'UNKNOWN_CELL'
  | 'PLANOGRAM_NOT_CONFIGURED';

export interface PlanogramCellRef {
  rowIndex: number;
  columnIndex: number;
  cellCode: string;
  /** 0..1 — how confidently the normalized point maps to THIS cell
   *  (1 at the cell center, → 0 toward a cell boundary). */
  confidence: number;
}

export interface CellAssignmentLike {
  cellCode: string;
  rowIndex: number;
  columnIndex: number;
  productId: string;
  skuCodeSnapshot: string;
  isPrimary: boolean;
}

export interface NarrowedCandidates {
  cell: PlanogramCellRef | null;
  matchableCell: boolean;
  /** Tier 1 — SKUs assigned to the detected cell. */
  cellSkus: string[];
  /** Tier 2 — SKUs assigned to the 8-neighborhood cells. */
  adjacentSkus: string[];
  /** Tier 3 — every SKU assigned anywhere on the rack. */
  rackSkus: string[];
  /** True when confidence fell below the floor (or no point given) and
   *  narrowing degraded to rack- then catalog-level search. */
  usedRackFallback: boolean;
}

// ------------------------------------------------------------ cell math

/** Row letter + 1-based column: rowIndex 1 / columnIndex 2 → "B3". */
export function cellCodeFor(rowIndex: number, columnIndex: number): string {
  return `${String.fromCharCode(65 + rowIndex)}${columnIndex + 1}`;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Map a normalized (0..1, top-left origin) rack position to a cell.
 * Confidence decays linearly from the cell center to its boundary in
 * each axis — a point near a gridline is honestly LOW confidence, which
 * the narrowing turns into a rack-level fallback instead of a wrong-cell
 * lock-in.
 */
export function cellFromNormalized(
  rows: number,
  columns: number,
  normalizedX: number,
  normalizedY: number,
): PlanogramCellRef {
  const x = clamp01(normalizedX);
  const y = clamp01(normalizedY);
  const rowIndex = Math.min(rows - 1, Math.floor(y * rows));
  const columnIndex = Math.min(columns - 1, Math.floor(x * columns));
  // Fractional offset from the cell center, 0 (center) .. 0.5 (edge).
  const cellX = x * columns - columnIndex;
  const cellY = y * rows - rowIndex;
  const confidence =
    (1 - 2 * Math.abs(cellX - 0.5)) * (1 - 2 * Math.abs(cellY - 0.5));
  return {
    rowIndex,
    columnIndex,
    cellCode: cellCodeFor(rowIndex, columnIndex),
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

/** The 8-neighborhood cell codes inside the grid. */
export function adjacentCellCodes(
  rows: number,
  columns: number,
  rowIndex: number,
  columnIndex: number,
): string[] {
  const codes: string[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) {
        continue;
      }
      const r = rowIndex + dr;
      const c = columnIndex + dc;
      if (r >= 0 && r < rows && c >= 0 && c < columns) {
        codes.push(cellCodeFor(r, c));
      }
    }
  }
  return codes;
}

// -------------------------------------------------------- narrowing

const unique = (values: string[]) => [...new Set(values)];

/**
 * Tiered SKU candidate narrowing for a detected rack position:
 * cell → adjacent cells → whole rack. Primary assignments sort first
 * within each tier. A missing/low-confidence point yields rack-level
 * candidates with usedRackFallback set (the caller widens to the full
 * catalog) — narrowing NEVER hides a SKU, it only re-orders priority.
 */
export function narrowFromAssignments(
  rack: { rows: number; columns: number },
  assignments: CellAssignmentLike[],
  point: { normalizedX: number; normalizedY: number } | null,
): NarrowedCandidates {
  const bySortedSku = (rows: CellAssignmentLike[]) =>
    unique(
      [...rows]
        .sort((a, b) =>
          a.isPrimary === b.isPrimary
            ? a.skuCodeSnapshot.localeCompare(b.skuCodeSnapshot)
            : a.isPrimary
              ? -1
              : 1,
        )
        .map((row) => row.skuCodeSnapshot),
    );
  const rackSkus = bySortedSku(assignments);
  if (!point) {
    return {
      cell: null,
      matchableCell: false,
      cellSkus: [],
      adjacentSkus: [],
      rackSkus,
      usedRackFallback: true,
    };
  }
  const cell = cellFromNormalized(
    rack.rows,
    rack.columns,
    point.normalizedX,
    point.normalizedY,
  );
  if (cell.confidence < CELL_CONFIDENCE_FLOOR) {
    return {
      cell,
      matchableCell: false,
      cellSkus: [],
      adjacentSkus: [],
      rackSkus,
      usedRackFallback: true,
    };
  }
  const adjacent = new Set(
    adjacentCellCodes(rack.rows, rack.columns, cell.rowIndex, cell.columnIndex),
  );
  const cellSkus = bySortedSku(
    assignments.filter((row) => row.cellCode === cell.cellCode),
  );
  const adjacentSkus = bySortedSku(
    assignments.filter((row) => adjacent.has(row.cellCode)),
  ).filter((sku) => !cellSkus.includes(sku));
  return {
    cell,
    matchableCell: true,
    cellSkus,
    adjacentSkus,
    rackSkus,
    usedRackFallback: false,
  };
}

/** Where the VISUAL top SKU sits relative to the planogram. */
export function planogramMatchStatusFor(
  visualTopSku: string | null,
  narrowed: NarrowedCandidates | null,
): PlanogramMatchStatus {
  if (narrowed === null) {
    return 'PLANOGRAM_NOT_CONFIGURED';
  }
  if (!narrowed.matchableCell) {
    return 'UNKNOWN_CELL';
  }
  if (visualTopSku === null) {
    return 'UNKNOWN_CELL';
  }
  if (narrowed.cellSkus.includes(visualTopSku)) {
    return 'MATCH';
  }
  if (narrowed.adjacentSkus.includes(visualTopSku)) {
    return 'ADJACENT_MATCH';
  }
  if (narrowed.rackSkus.includes(visualTopSku)) {
    return 'RACK_MATCH';
  }
  return 'OUT_OF_PLANOGRAM';
}

export interface PlanogramPriorResult {
  candidates: { sku: string; score: number; planogramBoost: number }[];
  matchStatus: PlanogramMatchStatus;
  /** Visual evidence and planogram disagree strongly enough that a
   *  human must decide — never an automatic rejection. */
  reviewRequired: boolean;
  /** Classified advisory flags (UPPER_SNAKE codes only). */
  flags: string[];
}

/**
 * Apply the planogram as a SOFT prior over visual SKU candidates:
 * boost expected SKUs (cell > adjacent > rack), never subtract, never
 * drop. A confident cell whose expectation disagrees with the visual
 * top candidate flags review and possible misplacement/drift instead of
 * rejecting the visual evidence.
 */
export function applyPlanogramPrior(
  candidates: { sku: string; score: number }[],
  narrowed: NarrowedCandidates | null,
): PlanogramPriorResult {
  const visualTop = candidates.length ? candidates[0].sku : null;
  const matchStatus = planogramMatchStatusFor(visualTop, narrowed);
  const flags: string[] = [];
  const confidence = narrowed?.cell?.confidence ?? 0;
  const boosted = candidates.map((candidate) => {
    let boost = 0;
    if (narrowed && narrowed.matchableCell) {
      if (narrowed.cellSkus.includes(candidate.sku)) {
        boost = CELL_PRIOR_BOOST * confidence;
      } else if (narrowed.adjacentSkus.includes(candidate.sku)) {
        boost = ADJACENT_PRIOR_BOOST * confidence;
      } else if (narrowed.rackSkus.includes(candidate.sku)) {
        boost = RACK_PRIOR_BOOST;
      }
    } else if (narrowed && narrowed.rackSkus.includes(candidate.sku)) {
      boost = RACK_PRIOR_BOOST;
    }
    return {
      sku: candidate.sku,
      score: Math.round((candidate.score + boost) * 1000) / 1000,
      planogramBoost: Math.round(boost * 1000) / 1000,
    };
  });
  // Expected-cell SKUs always PARTICIPATE, at prior-only weight: a SKU
  // the planogram expects but the visual ranker did not surface enters
  // with score == its boost (small by design — real visual evidence
  // dominates). Without this, a truncated visual top-N could hide the
  // expected SKU from the comparison entirely.
  if (narrowed && narrowed.matchableCell) {
    for (const sku of narrowed.cellSkus) {
      if (!boosted.some((row) => row.sku === sku)) {
        const boost = Math.round(CELL_PRIOR_BOOST * confidence * 1000) / 1000;
        boosted.push({ sku, score: boost, planogramBoost: boost });
      }
    }
  }
  boosted.sort((a, b) => b.score - a.score);

  let reviewRequired = false;
  if (narrowed === null) {
    flags.push('PLANOGRAM_NOT_CONFIGURED');
  } else if (!narrowed.matchableCell) {
    flags.push('CELL_MAPPING_UNCERTAIN');
    if (narrowed.usedRackFallback) {
      flags.push('RACK_FALLBACK_USED');
    }
  } else if (visualTop !== null && narrowed.cellSkus.length > 0) {
    if (matchStatus === 'ADJACENT_MATCH') {
      flags.push('POSSIBLE_PLANOGRAM_DRIFT');
    } else if (
      matchStatus === 'RACK_MATCH' ||
      matchStatus === 'OUT_OF_PLANOGRAM'
    ) {
      // The visual evidence names a SKU the confident cell does not
      // expect: soft prior, so keep the SKU — but a human decides.
      flags.push('POSSIBLE_MISPLACED_PRODUCT');
      reviewRequired = true;
    }
  }
  return { candidates: boosted, matchStatus, reviewRequired, flags };
}
