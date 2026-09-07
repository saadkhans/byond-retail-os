import { WeightedCandidateFusion } from './adapters/context-fusion-inventory';
import {
  FUSION_SIGNAL_CLASSES,
  FUSION_WEIGHTS,
  availableSignalClasses,
  effectiveWeights,
  planogramSignalsFor,
  rackPointFor,
} from './fusion-weighting';
import { CandidateSignal } from './ports';

const signal = (productId: string, score: number, detail?: string): CandidateSignal => ({
  productId,
  sku: productId,
  score,
  ...(detail ? { detail } : {}),
});

const META = new Map([
  ['WATER', { sku: 'WATER', name: 'Water' }],
  ['CAN', { sku: 'CAN', name: 'Can' }],
]);

const AUTO_THRESHOLD = 0.42;

describe('fusion-weighting — base table', () => {
  it('sums to 1.0 and covers every class', () => {
    const sum = FUSION_SIGNAL_CLASSES.reduce((acc, source) => acc + FUSION_WEIGHTS[source], 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(FUSION_SIGNAL_CLASSES).toEqual([
      'barcode',
      'classical',
      'retrieval',
      'ocr',
      'context',
      'planogram',
    ]);
  });
});

describe('fusion-weighting — availability', () => {
  it('context is always available; identity classes need at least one signal; planogram needs a consulted rack', () => {
    const none = availableSignalClasses({
      barcode: [],
      classical: [],
      retrieval: [],
      ocr: [],
      context: [],
      planogram: null,
    });
    expect([...none]).toEqual(['context']);
    const some = availableSignalClasses({
      barcode: [],
      classical: [signal('WATER', 0.3)],
      retrieval: [signal('WATER', 0.4)],
      ocr: [],
      context: [],
      planogram: [signal('WATER', 0)],
    });
    expect([...some].sort()).toEqual(['classical', 'context', 'planogram', 'retrieval']);
  });
});

describe('fusion-weighting — effectiveWeights', () => {
  it('renormalizes the available classes to 1 and zeroes the rest', () => {
    const weighting = effectiveWeights(new Set(['classical', 'retrieval', 'context']));
    const sum = FUSION_SIGNAL_CLASSES.reduce((acc, s) => acc + weighting.weights[s], 0);
    expect(sum).toBeCloseTo(1, 3);
    expect(weighting.weights.barcode).toBe(0);
    expect(weighting.weights.ocr).toBe(0);
    expect(weighting.weights.planogram).toBe(0);
    expect(weighting.unavailable).toEqual(['barcode', 'ocr', 'planogram']);
  });

  it('coverage is the square root of the available IDENTITY weight (context never counts)', () => {
    expect(effectiveWeights(new Set(['context'])).coverage).toBe(0);
    expect(effectiveWeights(new Set(['classical', 'context'])).coverage).toBeCloseTo(
      Math.sqrt(0.18),
      3,
    );
    expect(
      effectiveWeights(new Set(['classical', 'retrieval', 'context'])).coverage,
    ).toBeCloseTo(Math.sqrt(0.36), 3);
    expect(
      effectiveWeights(new Set(['classical', 'retrieval', 'planogram', 'context'])).coverage,
    ).toBeCloseTo(Math.sqrt(0.51), 3);
    expect(effectiveWeights(new Set(FUSION_SIGNAL_CLASSES)).coverage).toBeCloseTo(
      Math.sqrt(0.93),
      3,
    );
  });
});

describe('fusion-weighting — threshold behaviour through the adapter', () => {
  const fusion = new WeightedCandidateFusion();

  it('a single strong classical match plus an in-stock prior stays below the auto threshold', () => {
    const [top] = fusion.fuse(
      {
        barcode: [],
        classical: [signal('WATER', 0.95)],
        retrieval: [],
        ocr: [],
        context: [signal('WATER', 0.8)],
      },
      META,
    );
    expect(top.fusedScore).toBeLessThan(AUTO_THRESHOLD);
  });

  it('a catalog-matched barcode plus the prior clears the threshold', () => {
    const [top] = fusion.fuse(
      {
        barcode: [signal('WATER', 1)],
        classical: [],
        retrieval: [],
        ocr: [],
        context: [signal('WATER', 0.8)],
      },
      META,
    );
    expect(top.fusedScore).toBeGreaterThanOrEqual(AUTO_THRESHOLD);
  });

  // Saad's second lab clip: classical 0.34 / retrieval 0.45 / in-stock 0.80
  // for the water bottle; classical 0.28 / retrieval 0.42 / in-stock 0.80
  // for the Nescafe can on the same rack. Old table: 0.238 (capped at
  // 0.52 for any visual-only event).
  const lab = {
    barcode: [] as CandidateSignal[],
    classical: [signal('WATER', 0.34), signal('CAN', 0.28)],
    retrieval: [signal('WATER', 0.45), signal('CAN', 0.42)],
    ocr: [] as CandidateSignal[],
    context: [signal('WATER', 0.8), signal('CAN', 0.8)],
  };

  it('unbound lab clip: renormalized but still below the threshold (visual agreement alone is not enough)', () => {
    const [top, second] = fusion.fuse({ ...lab, planogram: null }, META);
    expect(top.sku).toBe('WATER');
    expect(top.fusedScore).toBeGreaterThan(0.238);
    expect(top.fusedScore).toBeLessThan(AUTO_THRESHOLD);
    expect(second.sku).toBe('CAN');
    // Reported in the PR: unbound fused value.
    expect(top.fusedScore).toBeCloseTo(0.276, 2);
  });

  it('bound lab clip with the water bottle in the event cell clears the threshold narrowly, the can does not', () => {
    const [top, second] = fusion.fuse(
      {
        ...lab,
        planogram: [signal('WATER', 1, 'planogram:cell(B1)'), signal('CAN', 0.6, 'planogram:rack')],
      },
      META,
    );
    expect(top.sku).toBe('WATER');
    expect(top.fusedScore).toBeGreaterThanOrEqual(AUTO_THRESHOLD);
    expect(top.fusedScore).toBeCloseTo(0.429, 2);
    expect(second.sku).toBe('CAN');
    expect(second.fusedScore).toBeLessThan(AUTO_THRESHOLD);
    expect(top.fusedScore - second.fusedScore).toBeGreaterThan(0.08);
    expect(top.signals.some((row) => row.source === 'planogram')).toBe(true);
  });
});

describe('fusion-weighting — planogram signal', () => {
  const rack = {
    rackCode: 'SHELF-2X2',
    rows: 2,
    columns: 2,
    cells: [
      { productId: 'WATER', rowIndex: 0, columnIndex: 0, cellCode: 'A1' },
      { productId: 'CAN', rowIndex: 0, columnIndex: 1, cellCode: 'A2' },
      { productId: 'WATER', rowIndex: 1, columnIndex: 0, cellCode: 'B1' },
      { productId: 'CAN', rowIndex: 1, columnIndex: 1, cellCode: 'B2' },
    ],
  };
  const candidates = [
    { productId: 'WATER', sku: 'WATER' },
    { productId: 'CAN', sku: 'CAN' },
    { productId: 'CHIPS', sku: 'CHIPS' },
  ];

  it('scores the event cell 1.0, the rest of the rack 0.6, off-rack 0', () => {
    const { signals, cellCode } = planogramSignalsFor(candidates, rack, { x: 0.25, y: 0.75 });
    expect(cellCode).toBe('B1');
    const bySku = new Map(signals.map((row) => [row.sku, row]));
    expect(bySku.get('WATER')).toMatchObject({ score: 1, detail: 'planogram:cell(B1)' });
    expect(bySku.get('CAN')).toMatchObject({ score: 0.6, detail: 'planogram:rack' });
    expect(bySku.get('CHIPS')).toMatchObject({ score: 0, detail: 'planogram:off-rack' });
  });

  it('without a rack point every rack SKU scores at rack level', () => {
    const { signals, cellCode } = planogramSignalsFor(candidates, rack, null);
    expect(cellCode).toBeNull();
    expect(signals.map((row) => row.score)).toEqual([0.6, 0.6, 0]);
  });

  it('maps the analysis-frame point through the rack frame region and rejects off-rack points', () => {
    expect(rackPointFor({ x: 0.5, y: 0.5 }, null)).toEqual({ x: 0.5, y: 0.5 });
    const region = { x: 0, y: 0.15, width: 1, height: 0.57 };
    const mapped = rackPointFor({ x: 0.16, y: 0.59 }, region);
    expect(mapped?.x).toBeCloseTo(0.16, 3);
    expect(mapped?.y).toBeCloseTo((0.59 - 0.15) / 0.57, 3);
    expect(rackPointFor({ x: 0.5, y: 0.9 }, region)).toBeNull();
    expect(rackPointFor({ x: 0.5, y: 0.5 }, { x: 0, y: 0, width: 0, height: 1 })).toBeNull();
  });
});
