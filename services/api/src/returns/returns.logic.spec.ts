import { InventoryMovementType, UnitOfMeasure } from '@prisma/client';
import { PG_INT_MAX } from '../common/integer-bounds';
import {
  compareCount,
  planReturn,
  PlannedReturnLine,
  ReturnableOrderLine,
  valueReturn,
} from './returns.logic';

function orderLine(
  overrides: Partial<ReturnableOrderLine> = {},
): ReturnableOrderLine {
  return {
    id: 'ol-1',
    productId: 'prod-1',
    sku: 'SKU-1',
    productName: 'Water 500ml',
    unitOfMeasure: UnitOfMeasure.EACH,
    quantity: 3,
    unitPriceMinor: 250,
    currencyCode: 'SAR',
    ...overrides,
  };
}

function planned(
  overrides: Partial<PlannedReturnLine> = {},
): PlannedReturnLine {
  return {
    orderLineId: 'ol-1',
    productId: 'prod-1',
    sku: 'SKU-1',
    productName: 'Water 500ml',
    unitOfMeasure: UnitOfMeasure.EACH,
    quantity: 1,
    restocked: true,
    note: null,
    refundAmountMinor: 250,
    currencyCode: 'SAR',
    ...overrides,
  };
}

describe('planReturn', () => {
  it('plans exactly what was asked for, valued from the order line snapshot', () => {
    const plan = planReturn([orderLine()], new Map(), [
      { orderLineId: 'ol-1', quantity: 2 },
    ]);
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') return;
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].quantity).toBe(2);
    expect(plan.lines[0].restocked).toBe(true);
    expect(plan.restockedQuantity).toBe(2);
    // Valued from the SNAPSHOT price, never from a live price book.
    expect(plan.refundAmountMinor).toBe(500);
    expect(plan.currencyCode).toBe('SAR');
  });

  it('counts earlier returns against the remaining quantity', () => {
    const already = new Map([['ol-1', 2]]);
    const ok = planReturn([orderLine()], already, [
      { orderLineId: 'ol-1', quantity: 1 },
    ]);
    expect(typeof ok).not.toBe('string');
    const tooMany = planReturn([orderLine()], already, [
      { orderLineId: 'ol-1', quantity: 2 },
    ]);
    expect(tooMany).toBe('quantity-exceeds-remaining');
  });

  it('never lets two entries for one line each pass the ceiling separately', () => {
    // Without the duplicate guard, 2 + 2 against a 3-unit line would be two
    // individually legal requests that together over-return it.
    const plan = planReturn([orderLine()], new Map(), [
      { orderLineId: 'ol-1', quantity: 2 },
      { orderLineId: 'ol-1', quantity: 2 },
    ]);
    expect(plan).toBe('duplicate-line');
  });

  it('refuses a line that is not on the order', () => {
    expect(
      planReturn([orderLine()], new Map(), [
        { orderLineId: 'ol-elsewhere', quantity: 1 },
      ]),
    ).toBe('line-not-on-order');
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])(
    'refuses a quantity of %p',
    (quantity) => {
      expect(
        planReturn([orderLine()], new Map(), [
          { orderLineId: 'ol-1', quantity },
        ]),
      ).toBe('quantity-invalid');
    },
  );

  it('refuses an empty customer return', () => {
    expect(planReturn([orderLine()], new Map(), [])).toBe('no-lines');
  });

  it('takes back everything outstanding when no lines are named', () => {
    const lines = [
      orderLine({ id: 'ol-1', quantity: 3 }),
      orderLine({ id: 'ol-2', productId: 'prod-2', sku: 'SKU-2', quantity: 1 }),
    ];
    const plan = planReturn(lines, new Map([['ol-1', 1]]), null);
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') return;
    expect(plan.lines.map((line) => [line.orderLineId, line.quantity])).toEqual([
      ['ol-1', 2],
      ['ol-2', 1],
    ]);
    expect(plan.restockedQuantity).toBe(3);
  });

  it('refuses a cancellation when every line has already come back', () => {
    expect(
      planReturn([orderLine({ quantity: 2 })], new Map([['ol-1', 2]]), null),
    ).toBe('nothing-left-to-return');
  });

  it('writes no restock for goods that did not go back on the shelf', () => {
    const plan = planReturn([orderLine()], new Map(), [
      { orderLineId: 'ol-1', quantity: 1, restock: false, note: ' damaged ' },
    ]);
    expect(typeof plan).not.toBe('string');
    if (typeof plan === 'string') return;
    expect(plan.lines[0].restocked).toBe(false);
    expect(plan.restockedQuantity).toBe(0);
    expect(plan.lines[0].note).toBe('damaged');
    // Damaged goods are still worth money back — restocking and refunding are
    // independent decisions.
    expect(plan.refundAmountMinor).toBe(250);
  });
});

describe('valueReturn', () => {
  it('sums a fully priced, single-currency return', () => {
    expect(
      valueReturn([
        planned({ refundAmountMinor: 250 }),
        planned({ orderLineId: 'ol-2', refundAmountMinor: 100 }),
      ]),
    ).toEqual({ refundAmountMinor: 350, currencyCode: 'SAR' });
  });

  it.each([
    [
      'an unpriced line',
      [planned(), planned({ orderLineId: 'ol-2', refundAmountMinor: null })],
    ],
    [
      'mixed currencies',
      [planned(), planned({ orderLineId: 'ol-2', currencyCode: 'USD' })],
    ],
    [
      'a line with an amount but no currency',
      [planned({ currencyCode: null })],
    ],
    ['nothing at all', []],
  ])('refuses to value %s', (_label, lines) => {
    // All or nothing: a partially valued return would quietly refund half of
    // itself and silently drop the rest.
    expect(valueReturn(lines)).toEqual({
      refundAmountMinor: null,
      currencyCode: null,
    });
  });

  it('refuses a total the money column cannot hold', () => {
    expect(
      valueReturn([
        planned({ refundAmountMinor: PG_INT_MAX }),
        planned({ orderLineId: 'ol-2', refundAmountMinor: 1 }),
      ]),
    ).toEqual({ refundAmountMinor: null, currencyCode: null });
  });
});

describe('compareCount', () => {
  it('turns a surplus into a signed CORRECTION_IN delta, never a level', () => {
    expect(
      compareCount({
        countedQuantity: 12,
        systemQuantity: 10,
        ledgerQuantity: 10,
      }),
    ).toEqual({
      varianceQuantity: 2,
      ledgerDriftQuantity: 0,
      movementType: InventoryMovementType.CORRECTION_IN,
    });
  });

  it('turns a shortfall into a signed CORRECTION_OUT delta', () => {
    expect(
      compareCount({
        countedQuantity: 7,
        systemQuantity: 10,
        ledgerQuantity: 10,
      }),
    ).toEqual({
      varianceQuantity: -3,
      ledgerDriftQuantity: 0,
      movementType: InventoryMovementType.CORRECTION_OUT,
    });
  });

  it('writes nothing when the count agrees with the books', () => {
    // A count that agrees must leave the ledger exactly as it found it —
    // otherwise every stocktake would pollute the history with no-op rows.
    expect(
      compareCount({
        countedQuantity: 10,
        systemQuantity: 10,
        ledgerQuantity: 10,
      }),
    ).toEqual({
      varianceQuantity: 0,
      ledgerDriftQuantity: 0,
      movementType: null,
    });
  });

  it('reports projection-vs-ledger drift separately from the variance', () => {
    // Drift is a PLATFORM bug (the projection disagrees with its own history),
    // not a stock discrepancy, so it must never be folded into the operator's
    // variance and silently "corrected".
    const comparison = compareCount({
      countedQuantity: 10,
      systemQuantity: 10,
      ledgerQuantity: 8,
    });
    expect(comparison.varianceQuantity).toBe(0);
    expect(comparison.movementType).toBeNull();
    expect(comparison.ledgerDriftQuantity).toBe(2);
  });
});
