import { CvProposal, decide, signedDelta } from './decision-policy';

function proposal(overrides: Partial<CvProposal> = {}): CvProposal {
  return {
    proposalId: 'p-1',
    type: 'PRODUCT_PICKUP',
    unitId: 'unit-1',
    productId: 'sku-water',
    quantity: 1,
    confidence: 0.9,
    occurredAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

const BASE = {
  confidenceThreshold: 0.75,
  productKnown: true,
  projectedStock: 5,
};

describe('edge decision policy', () => {
  it('accepts a confident pickup of a known product that stock supports', () => {
    const outcome = decide({ ...BASE, proposal: proposal() });
    expect(outcome.decision).toBe('ACCEPT');
    expect(outcome.quantityDelta).toBe(-1);
    expect(outcome.reasons).toEqual(['WITHIN_POLICY']);
  });

  it('accepts a return as a positive movement', () => {
    const outcome = decide({
      ...BASE,
      proposal: proposal({ type: 'PRODUCT_RETURN', quantity: 2 }),
    });
    expect(outcome.decision).toBe('ACCEPT');
    expect(outcome.quantityDelta).toBe(2);
  });

  it('sends a low-confidence proposal to review instead of the ledger', () => {
    const outcome = decide({
      ...BASE,
      proposal: proposal({ confidence: 0.4 }),
    });
    expect(outcome.decision).toBe('REVIEW');
    expect(outcome.reasons).toContain('LOW_CONFIDENCE');
    expect(outcome.quantityDelta).toBe(0);
  });

  it('treats the threshold as inclusive from above', () => {
    expect(
      decide({ ...BASE, proposal: proposal({ confidence: 0.75 }) }).decision,
    ).toBe('ACCEPT');
    expect(
      decide({ ...BASE, proposal: proposal({ confidence: 0.749 }) }).decision,
    ).toBe('REVIEW');
  });

  it('reviews a product the local catalog does not know', () => {
    const outcome = decide({ ...BASE, productKnown: false, proposal: proposal() });
    expect(outcome.decision).toBe('REVIEW');
    expect(outcome.reasons).toContain('UNKNOWN_PRODUCT');
  });

  it('reviews a proposal with no product at all', () => {
    const outcome = decide({
      ...BASE,
      proposal: proposal({ productId: undefined }),
    });
    expect(outcome.decision).toBe('REVIEW');
    expect(outcome.reasons).toContain('UNKNOWN_PRODUCT');
  });

  it('lets inventory veto a pickup the ledger cannot support', () => {
    const outcome = decide({
      ...BASE,
      projectedStock: 0,
      proposal: proposal(),
    });
    expect(outcome.decision).toBe('REVIEW');
    expect(outcome.reasons).toContain('WOULD_DRIVE_STOCK_NEGATIVE');
  });

  it('allows a pickup that takes stock exactly to zero', () => {
    expect(
      decide({ ...BASE, projectedStock: 1, proposal: proposal() }).decision,
    ).toBe('ACCEPT');
  });

  it('never lets a return be vetoed by stock', () => {
    expect(
      decide({
        ...BASE,
        projectedStock: 0,
        proposal: proposal({ type: 'PRODUCT_RETURN' }),
      }).decision,
    ).toBe('ACCEPT');
  });

  it('reviews events that are observations rather than stock movements', () => {
    for (const type of ['CART_INSERTION', 'EXIT_RECONCILIATION', 'PRODUCT_TRANSFER'] as const) {
      const outcome = decide({ ...BASE, proposal: proposal({ type }) });
      expect(outcome.decision).toBe('REVIEW');
      expect(outcome.reasons).toContain('NOT_A_STOCK_EVENT');
    }
  });

  it('rejects a malformed proposal outright', () => {
    for (const bad of [
      proposal({ quantity: 0 }),
      proposal({ quantity: -2 }),
      proposal({ quantity: 1.5 }),
      proposal({ confidence: 1.4 }),
      proposal({ confidence: Number.NaN }),
    ]) {
      const outcome = decide({ ...BASE, proposal: bad });
      expect(outcome.decision).toBe('REJECT');
      expect(outcome.reasons).toEqual(['MALFORMED_PROPOSAL']);
    }
  });

  it('collects every failing reason rather than stopping at the first', () => {
    const outcome = decide({
      ...BASE,
      productKnown: false,
      projectedStock: 0,
      proposal: proposal({ confidence: 0.1 }),
    });
    expect(outcome.reasons).toEqual(
      expect.arrayContaining([
        'UNKNOWN_PRODUCT',
        'LOW_CONFIDENCE',
        'WOULD_DRIVE_STOCK_NEGATIVE',
      ]),
    );
  });
});

describe('signedDelta', () => {
  it('is negative for a pickup, positive for a return, zero otherwise', () => {
    expect(signedDelta('PRODUCT_PICKUP', 3)).toBe(-3);
    expect(signedDelta('PRODUCT_RETURN', 3)).toBe(3);
    expect(signedDelta('CART_INSERTION', 3)).toBe(0);
  });
});
