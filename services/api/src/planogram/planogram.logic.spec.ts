import {
  ADJACENT_PRIOR_BOOST,
  CELL_CONFIDENCE_FLOOR,
  CELL_PRIOR_BOOST,
  adjacentCellCodes,
  applyPlanogramPrior,
  cellCodeFor,
  cellFromNormalized,
  narrowFromAssignments,
  planogramMatchStatusFor,
} from './planogram.logic';

const RACK = { rows: 4, columns: 4 };

/** A1..D4 fixture: SKU-<cellCode> assigned to each cell. */
function assignments() {
  const rows: {
    cellCode: string;
    rowIndex: number;
    columnIndex: number;
    productId: string;
    skuCodeSnapshot: string;
    isPrimary: boolean;
  }[] = [];
  for (let r = 0; r < RACK.rows; r += 1) {
    for (let c = 0; c < RACK.columns; c += 1) {
      const cellCode = cellCodeFor(r, c);
      rows.push({
        cellCode,
        rowIndex: r,
        columnIndex: c,
        productId: `prod-${cellCode}`,
        skuCodeSnapshot: `SKU-${cellCode}`,
        isPrimary: true,
      });
    }
  }
  return rows;
}

/** Center of a cell in normalized rack coordinates. */
const centerOf = (rowIndex: number, columnIndex: number) => ({
  normalizedX: (columnIndex + 0.5) / RACK.columns,
  normalizedY: (rowIndex + 0.5) / RACK.rows,
});

describe('planogram cell math', () => {
  it('names cells row-letter + 1-based column (B3 for row 1, column 2)', () => {
    expect(cellCodeFor(0, 0)).toBe('A1');
    expect(cellCodeFor(1, 2)).toBe('B3');
    expect(cellCodeFor(3, 3)).toBe('D4');
  });

  it('maps a cell-center point to that cell with full confidence', () => {
    const point = centerOf(1, 2);
    const cell = cellFromNormalized(4, 4, point.normalizedX, point.normalizedY);
    expect(cell.cellCode).toBe('B3');
    expect(cell.confidence).toBe(1);
  });

  it('reports LOW confidence at a gridline — honesty over lock-in', () => {
    // x exactly on the boundary between columns 1 and 2.
    const cell = cellFromNormalized(4, 4, 0.5, 0.125);
    expect(cell.confidence).toBeLessThan(CELL_CONFIDENCE_FLOOR);
  });

  it('computes the 8-neighborhood inside the grid only', () => {
    expect(adjacentCellCodes(4, 4, 0, 0).sort()).toEqual(
      ['A2', 'B1', 'B2'].sort(),
    );
    expect(adjacentCellCodes(4, 4, 1, 2)).toHaveLength(8);
  });
});

describe('planogram candidate narrowing', () => {
  it('returns detected-cell SKUs first, then adjacent, then rack (B3 fixture)', () => {
    const point = centerOf(1, 2); // B3
    const narrowed = narrowFromAssignments(RACK, assignments(), point);
    expect(narrowed.cell?.cellCode).toBe('B3');
    expect(narrowed.cellSkus).toEqual(['SKU-B3']);
    expect(narrowed.adjacentSkus.sort()).toEqual(
      ['SKU-A2', 'SKU-A3', 'SKU-A4', 'SKU-B2', 'SKU-B4', 'SKU-C2', 'SKU-C3', 'SKU-C4'].sort(),
    );
    expect(narrowed.rackSkus).toHaveLength(16);
    expect(narrowed.usedRackFallback).toBe(false);
    // Unrelated cells are NOT prioritized into the top tiers.
    expect(narrowed.cellSkus).not.toContain('SKU-D1');
    expect(narrowed.adjacentSkus).not.toContain('SKU-D1');
  });

  it('falls back to the whole rack when cell confidence is low', () => {
    const narrowed = narrowFromAssignments(RACK, assignments(), {
      normalizedX: 0.5, // exactly on a gridline
      normalizedY: 0.5,
    });
    expect(narrowed.matchableCell).toBe(false);
    expect(narrowed.usedRackFallback).toBe(true);
    expect(narrowed.cellSkus).toEqual([]);
    expect(narrowed.rackSkus).toHaveLength(16);
  });

  it('falls back to the whole rack when no point is available', () => {
    const narrowed = narrowFromAssignments(RACK, assignments(), null);
    expect(narrowed.usedRackFallback).toBe(true);
    expect(narrowed.rackSkus).toHaveLength(16);
  });
});

describe('planogram match status + soft prior', () => {
  const narrowedAt = (rowIndex: number, columnIndex: number) =>
    narrowFromAssignments(RACK, assignments(), centerOf(rowIndex, columnIndex));

  it('classifies MATCH / ADJACENT_MATCH / RACK_MATCH / OUT_OF_PLANOGRAM', () => {
    const narrowed = narrowedAt(1, 2); // B3
    expect(planogramMatchStatusFor('SKU-B3', narrowed)).toBe('MATCH');
    expect(planogramMatchStatusFor('SKU-C2', narrowed)).toBe('ADJACENT_MATCH');
    expect(planogramMatchStatusFor('SKU-D1', narrowed)).toBe('RACK_MATCH');
    expect(planogramMatchStatusFor('SKU-FOREIGN', narrowed)).toBe(
      'OUT_OF_PLANOGRAM',
    );
    expect(planogramMatchStatusFor('SKU-B3', null)).toBe(
      'PLANOGRAM_NOT_CONFIGURED',
    );
  });

  it('boosts expected SKUs (cell > adjacent > rack) without dropping any candidate', () => {
    const narrowed = narrowedAt(1, 2); // B3, confidence 1
    const result = applyPlanogramPrior(
      [
        { sku: 'SKU-FOREIGN', score: 0.5 },
        { sku: 'SKU-B3', score: 0.45 },
        { sku: 'SKU-C2', score: 0.44 },
      ],
      narrowed,
    );
    const bySku = new Map(result.candidates.map((row) => [row.sku, row]));
    expect(bySku.get('SKU-B3')?.planogramBoost).toBe(CELL_PRIOR_BOOST);
    expect(bySku.get('SKU-C2')?.planogramBoost).toBe(ADJACENT_PRIOR_BOOST);
    expect(bySku.get('SKU-FOREIGN')?.planogramBoost).toBe(0);
    // Nothing was removed; the expected-cell SKU now ranks first.
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].sku).toBe('SKU-B3');
  });

  it('injects an expected-cell SKU the visual ranker missed, at prior-only weight', () => {
    const narrowed = narrowedAt(1, 2); // B3 expects SKU-B3
    const result = applyPlanogramPrior(
      [{ sku: 'SKU-OTHER', score: 0.9 }],
      narrowed,
    );
    const injected = result.candidates.find((row) => row.sku === 'SKU-B3');
    // Present, but at boost-only weight — visual evidence still wins.
    expect(injected).toEqual({
      sku: 'SKU-B3',
      score: CELL_PRIOR_BOOST,
      planogramBoost: CELL_PRIOR_BOOST,
    });
    expect(result.candidates[0].sku).toBe('SKU-OTHER');
  });

  it('flags REVIEW_REQUIRED (not rejection) when visual evidence leaves the planogram', () => {
    const narrowed = narrowedAt(1, 2); // B3 expects SKU-B3
    const result = applyPlanogramPrior(
      [{ sku: 'SKU-FOREIGN', score: 0.9 }],
      narrowed,
    );
    expect(result.matchStatus).toBe('OUT_OF_PLANOGRAM');
    expect(result.reviewRequired).toBe(true);
    expect(result.flags).toContain('POSSIBLE_MISPLACED_PRODUCT');
    // The visually supported SKU SURVIVES — soft prior, never a lock.
    expect(result.candidates[0].sku).toBe('SKU-FOREIGN');
  });

  it('flags possible planogram drift on an adjacent-cell match', () => {
    const narrowed = narrowedAt(1, 2);
    const result = applyPlanogramPrior([{ sku: 'SKU-C2', score: 0.8 }], narrowed);
    expect(result.matchStatus).toBe('ADJACENT_MATCH');
    expect(result.reviewRequired).toBe(false);
    expect(result.flags).toContain('POSSIBLE_PLANOGRAM_DRIFT');
  });

  it('reports uncertain cell mapping instead of guessing', () => {
    const narrowed = narrowFromAssignments(RACK, assignments(), {
      normalizedX: 0.5,
      normalizedY: 0.5,
    });
    const result = applyPlanogramPrior([{ sku: 'SKU-B3', score: 0.8 }], narrowed);
    expect(result.matchStatus).toBe('UNKNOWN_CELL');
    expect(result.flags).toContain('CELL_MAPPING_UNCERTAIN');
    expect(result.reviewRequired).toBe(false);
  });
});
