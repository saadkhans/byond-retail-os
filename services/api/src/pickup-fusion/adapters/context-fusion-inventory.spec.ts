import { FUSION_WEIGHTS, WeightedCandidateFusion } from './context-fusion-inventory';
import { CandidateSignal } from '../ports';

function signal(sku: string, score: number, detail?: string): CandidateSignal {
  return { productId: `p-${sku}`, sku, score, ...(detail ? { detail } : {}) };
}

const PRODUCT_META = new Map(
  ['A', 'B'].map((sku) => [`p-${sku}`, { sku, name: `Product ${sku}` }]),
);

describe('WeightedCandidateFusion', () => {
  it('counts each signal source once per candidate: duplicate barcode rows contribute the max, not the sum', () => {
    // Two registered barcode reads of the SAME product (crop frame + peak
    // frame). Summing would yield 2 x 0.35 = 0.70 from one signal class —
    // enough to clear the 0.42 auto threshold alone. The max rule keeps it
    // at 0.35.
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [signal('A', 1, 'crop-frame'), signal('A', 1, 'peak-frame')],
        classical: [],
        retrieval: [],
        ocr: [],
        context: [],
      },
      PRODUCT_META,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].fusedScore).toBe(FUSION_WEIGHTS.barcode);
    // Both rows are still retained verbatim as evidence.
    expect(fused[0].signals).toHaveLength(2);
    expect(fused[0].signals.map((s) => s.detail)).toEqual([
      'crop-frame',
      'peak-frame',
    ]);
  });

  it('keeps the max score when duplicate rows from one source differ', () => {
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [],
        classical: [signal('A', 0.4), signal('A', 0.9)],
        retrieval: [],
        ocr: [],
        context: [],
      },
      PRODUCT_META,
    );
    expect(fused[0].fusedScore).toBe(
      Math.round(FUSION_WEIGHTS.classical * 0.9 * 10_000) / 10_000,
    );
  });

  it('still sums across DISTINCT sources for the same candidate', () => {
    const fused = new WeightedCandidateFusion().fuse(
      {
        barcode: [signal('A', 1)],
        classical: [signal('A', 0.5)],
        retrieval: [],
        ocr: [],
        context: [signal('A', 0.5), signal('B', 0.5)],
      },
      PRODUCT_META,
    );
    const expected =
      FUSION_WEIGHTS.barcode * 1 +
      FUSION_WEIGHTS.classical * 0.5 +
      FUSION_WEIGHTS.context * 0.5;
    expect(fused[0].sku).toBe('A');
    expect(fused[0].fusedScore).toBe(Math.round(expected * 10_000) / 10_000);
  });
});
