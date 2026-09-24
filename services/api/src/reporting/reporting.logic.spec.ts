import {
  buildBalances,
  buildCountReconciliation,
  buildCvAccuracy,
  buildShrinkReport,
  checkOrderLine,
  resolveWindow,
  rollUpSales,
  SalesPricePoint,
  summariseMovements,
  VerdictGroup,
} from './reporting.logic';

/**
 * The arithmetic, not the plumbing.
 *
 * Every test below is a number computed by hand and then asserted against the
 * code: a sales total that reconciles to its lines including the promotion
 * discount, an inventory balance that equals the sum of its movements, drift
 * kept apart from variance, a shrink total that excludes damaged returns, and
 * an accuracy figure that matches a hand-built confusion matrix.
 */

const pricePoint = (
  overrides: Partial<SalesPricePoint> & Pick<SalesPricePoint, 'units'>,
): SalesPricePoint => ({
  productId: 'prod-1',
  sku: 'SKU-1',
  productName: 'Water 500ml',
  currencyCode: 'GBP',
  priceBookVersionId: 'pbv-1',
  promotionVersionId: null,
  basePriceMinor: 100,
  promotionDiscountMinor: null,
  unitPriceMinor: 100,
  lineTotalMinor: 100 * overrides.units,
  lines: 1,
  ...overrides,
});

describe('sales roll-up', () => {
  it('reconciles a total to its lines including the promotion discount', () => {
    // Hand arithmetic:
    //   5 units at a base of 250, promotion takes 50 off each
    //     -> gross 1250, discount 250, net 1000
    //   3 units at a base of 100, no promotion
    //     -> gross 300, discount 0, net 300
    //   gross 1550 - discount 250 = net 1300.
    const rolled = rollUpSales([
      pricePoint({
        productId: 'prod-a',
        sku: 'SKU-A',
        units: 5,
        lines: 2,
        basePriceMinor: 250,
        promotionDiscountMinor: 50,
        unitPriceMinor: 200,
        lineTotalMinor: 1000,
        promotionVersionId: 'promo-v1',
      }),
      pricePoint({
        productId: 'prod-b',
        sku: 'SKU-B',
        units: 3,
        lines: 1,
        basePriceMinor: 100,
        unitPriceMinor: 100,
        lineTotalMinor: 300,
      }),
    ]);

    expect(rolled.byCurrency).toHaveLength(1);
    const gbp = rolled.byCurrency[0];
    expect(gbp.currencyCode).toBe('GBP');
    expect(gbp.grossSalesMinor).toBe(1550);
    expect(gbp.promotionDiscountMinor).toBe(250);
    expect(gbp.netSalesMinor).toBe(1300);
    expect(gbp.unitsSold).toBe(8);
    expect(gbp.lines).toBe(3);
    // The identity that makes the figure explainable at all.
    expect(gbp.grossSalesMinor - gbp.promotionDiscountMinor).toBe(
      gbp.netSalesMinor,
    );
    expect(gbp.reconciled).toBe(true);
    expect(rolled.inconsistentPricePoints).toBe(0);
  });

  it('attributes the discount to the promotion version that granted it', () => {
    const rolled = rollUpSales([
      pricePoint({
        units: 4,
        basePriceMinor: 500,
        promotionDiscountMinor: 100,
        unitPriceMinor: 400,
        lineTotalMinor: 1600,
        promotionVersionId: 'promo-v2',
        priceBookVersionId: 'pbv-7',
      }),
      pricePoint({
        units: 2,
        basePriceMinor: 500,
        unitPriceMinor: 500,
        lineTotalMinor: 1000,
        promotionVersionId: null,
        priceBookVersionId: 'pbv-7',
      }),
    ]);

    const promoted = rolled.byPromotionVersion.find(
      (row) => row.promotionVersionId === 'promo-v2',
    );
    const unpromoted = rolled.byPromotionVersion.find(
      (row) => row.promotionVersionId === null,
    );
    expect(promoted?.promotionDiscountMinor).toBe(400);
    expect(promoted?.netSalesMinor).toBe(1600);
    expect(unpromoted?.promotionDiscountMinor).toBe(0);
    expect(unpromoted?.netSalesMinor).toBe(1000);

    // Both price points cite the SAME price version, so the version total is
    // the sum of what it priced — before any promotion touched it.
    expect(rolled.byPriceBookVersion).toHaveLength(1);
    expect(rolled.byPriceBookVersion[0].priceBookVersionId).toBe('pbv-7');
    expect(rolled.byPriceBookVersion[0].grossSalesMinor).toBe(3000);
  });

  it('treats a pre-promotion order line as its own base price, keeping the identity true', () => {
    // Orders placed before the provenance columns existed carry NULL base and
    // NULL discount. Gross must equal net for them, not zero.
    const rolled = rollUpSales([
      pricePoint({
        units: 3,
        basePriceMinor: null,
        promotionDiscountMinor: null,
        unitPriceMinor: 199,
        lineTotalMinor: 597,
        priceBookVersionId: null,
      }),
    ]);
    const gbp = rolled.byCurrency[0];
    expect(gbp.grossSalesMinor).toBe(597);
    expect(gbp.promotionDiscountMinor).toBe(0);
    expect(gbp.netSalesMinor).toBe(597);
    expect(gbp.reconciled).toBe(true);
  });

  it('counts unpriced lines instead of treating NULL money as free', () => {
    const rolled = rollUpSales([
      pricePoint({
        units: 7,
        lines: 4,
        basePriceMinor: null,
        unitPriceMinor: null,
        lineTotalMinor: null,
        currencyCode: null,
      }),
    ]);
    expect(rolled.byCurrency).toHaveLength(0);
    expect(rolled.unpricedLines).toBe(4);
    expect(rolled.unpricedUnits).toBe(7);
  });

  it('never sums two currencies into one figure', () => {
    const rolled = rollUpSales([
      pricePoint({ units: 2, currencyCode: 'GBP', lineTotalMinor: 200 }),
      pricePoint({ units: 3, currencyCode: 'EUR', lineTotalMinor: 300 }),
    ]);
    expect(rolled.byCurrency.map((row) => row.currencyCode).sort()).toEqual([
      'EUR',
      'GBP',
    ]);
    expect(
      rolled.byCurrency.find((row) => row.currencyCode === 'GBP')?.netSalesMinor,
    ).toBe(200);
    expect(
      rolled.byCurrency.find((row) => row.currencyCode === 'EUR')?.netSalesMinor,
    ).toBe(300);
  });

  it('surfaces a price point whose own columns contradict each other', () => {
    // base 100 - discount 10 should be 90, but the line says it charged 95.
    const rolled = rollUpSales([
      pricePoint({
        units: 1,
        basePriceMinor: 100,
        promotionDiscountMinor: 10,
        unitPriceMinor: 95,
        lineTotalMinor: 95,
      }),
    ]);
    expect(rolled.inconsistentPricePoints).toBe(1);
    // And the currency total admits it rather than quietly re-deriving one
    // side to make the books balance.
    expect(rolled.byCurrency[0].reconciled).toBe(false);
  });
});

describe('one sale, explained', () => {
  it('checks both halves of the arithmetic on a promoted line', () => {
    expect(
      checkOrderLine({
        quantity: 3,
        basePriceMinor: 250,
        promotionDiscountMinor: 50,
        unitPriceMinor: 200,
        lineTotalMinor: 600,
      }),
    ).toEqual({
      unitPriceMatchesBaseMinusDiscount: true,
      lineTotalMatchesUnitTimesQuantity: true,
    });
  });

  it('fails the check when the line total does not follow from the unit price', () => {
    expect(
      checkOrderLine({
        quantity: 3,
        basePriceMinor: 250,
        promotionDiscountMinor: 50,
        unitPriceMinor: 200,
        lineTotalMinor: 599,
      }).lineTotalMatchesUnitTimesQuantity,
    ).toBe(false);
  });

  it('claims nothing about an unpriced line', () => {
    expect(
      checkOrderLine({
        quantity: 2,
        basePriceMinor: null,
        promotionDiscountMinor: null,
        unitPriceMinor: null,
        lineTotalMinor: null,
      }),
    ).toEqual({
      unitPriceMatchesBaseMinusDiscount: true,
      lineTotalMatchesUnitTimesQuantity: true,
    });
  });
});

describe('inventory balances', () => {
  it('reports the balance as the sum of its movements', () => {
    // 20 received, 3 sold, 1 written off, 2 returned = 18.
    const body = buildBalances(
      [
        {
          locationId: 'loc-1',
          productId: 'prod-1',
          ledgerQuantity: 20 - 3 - 1 + 2,
          movements: 4,
        },
      ],
      [{ locationId: 'loc-1', productId: 'prod-1', quantity: 18 }],
    );
    expect(body.rows[0].ledgerQuantity).toBe(18);
    expect(body.rows[0].projectedQuantity).toBe(18);
    expect(body.rows[0].projectionDriftQuantity).toBe(0);
    expect(body.summary.ledgerQuantity).toBe(18);
    expect(body.summary.projectionHealthy).toBe(true);
  });

  it('reports a projection that disagrees with its own ledger as drift, keeping the ledger figure', () => {
    const body = buildBalances(
      [
        { locationId: 'loc-1', productId: 'prod-1', ledgerQuantity: 10, movements: 3 },
        { locationId: 'loc-1', productId: 'prod-2', ledgerQuantity: 5, movements: 2 },
      ],
      [
        { locationId: 'loc-1', productId: 'prod-1', quantity: 12 },
        { locationId: 'loc-1', productId: 'prod-2', quantity: 5 },
      ],
    );
    // The BALANCE stays the ledger's: 10, not 12.
    expect(body.rows[0].ledgerQuantity).toBe(10);
    expect(body.rows[0].projectionDriftQuantity).toBe(2);
    expect(body.summary.driftingPairs).toBe(1);
    expect(body.summary.totalAbsoluteDrift).toBe(2);
    expect(body.summary.projectionHealthy).toBe(false);
  });

  it('says nothing about drift when there is no projection row to compare', () => {
    const body = buildBalances(
      [{ locationId: 'loc-1', productId: 'prod-9', ledgerQuantity: 4, movements: 1 }],
      [],
    );
    expect(body.rows[0].projectedQuantity).toBeNull();
    expect(body.rows[0].projectionDriftQuantity).toBeNull();
    expect(body.summary.driftingPairs).toBe(0);
  });
});

describe('cycle-count reconciliation', () => {
  it('keeps projection drift out of the operator variance, and vice versa', () => {
    // Three lines. Variance totals -4 (stock actually missing, already
    // corrected through the ledger). Drift totals +2 on ONE line (the
    // projection disagreeing with its own history — a platform bug).
    const report = buildCountReconciliation({
      lines: 3,
      varianceQuantitySum: -4,
      varianceLines: 2,
      ledgerDriftQuantitySum: 2,
      ledgerDriftLines: 1,
    });

    expect(report.variance.totalQuantity).toBe(-4);
    expect(report.variance.lines).toBe(2);
    expect(report.projectionDefect.totalDriftQuantity).toBe(2);
    expect(report.projectionDefect.lines).toBe(1);
    // The two never meet. Neither total is the other's net (-4 + 2 = -2), and
    // no field in the payload carries that combined figure.
    expect(report.variance.totalQuantity).not.toBe(-2);
    expect(report.projectionDefect.totalDriftQuantity).not.toBe(-2);
    const numbers = JSON.stringify(report).match(/-?\d+/g) ?? [];
    expect(numbers).not.toContain('-2');
    expect(report.varianceIncludesDrift).toBe(false);
    expect(report.projectionDefect.severity).toBe('PLATFORM_DEFECT');
    expect(report.projectionDefect.healthy).toBe(false);
  });

  it('calls a healthy projection healthy, even when the count found real variance', () => {
    const report = buildCountReconciliation({
      lines: 5,
      varianceQuantitySum: -11,
      varianceLines: 3,
      ledgerDriftQuantitySum: 0,
      ledgerDriftLines: 0,
    });
    expect(report.variance.totalQuantity).toBe(-11);
    expect(report.projectionDefect.healthy).toBe(true);
    expect(report.projectionDefect.severity).toBe('NONE');
  });
});

describe('shrink', () => {
  it('excludes damaged returns from the shrink total and reconciles to the ledger', () => {
    // Shrink: 3 units of prod-1 (CV detected) + 2 of prod-2 (operator) = 5.
    // Damaged returns: 4 units that never went back on the shelf — and never
    // produced a ledger movement, so they are NOT shrink.
    const report = buildShrinkReport(
      [
        { productId: 'prod-1', source: 'CV_DETECTED', units: 3, events: 2 },
        { productId: 'prod-2', source: 'OPERATOR', units: 2, events: 1 },
      ],
      { quantityDeltaSum: -5, movements: 3 },
      [{ productId: 'prod-3', units: 4, lines: 2 }],
    );

    expect(report.shrink.units).toBe(5);
    expect(report.shrink.events).toBe(3);
    expect(report.damagedReturns.units).toBe(4);
    // 5, not 9 — and the damaged product never appears in a shrink bucket.
    expect(report.shrink.units).toBe(5);
    expect(report.shrink.byProduct.map((row) => row.productId)).not.toContain(
      'prod-3',
    );
    expect(report.damagedReturns.ledgerMovementsWritten).toBe(0);
    // The SHRINK movements the ledger carries must account for exactly the
    // units the shrink records claim.
    expect(report.ledgerCheck.shrinkMovementUnits).toBe(5);
    expect(report.ledgerCheck.reconciled).toBe(true);
  });

  it('refuses to reconcile when the ledger and the shrink records disagree', () => {
    const report = buildShrinkReport(
      [{ productId: 'prod-1', source: 'CV_DETECTED', units: 3, events: 1 }],
      { quantityDeltaSum: -2, movements: 1 },
      [],
    );
    expect(report.ledgerCheck.shrinkMovementUnits).toBe(2);
    expect(report.ledgerCheck.reconciled).toBe(false);
  });

  it('splits shrink by where the decision came from', () => {
    const report = buildShrinkReport(
      [
        { productId: 'prod-1', source: 'CV_DETECTED', units: 6, events: 3 },
        { productId: 'prod-2', source: 'CV_DETECTED', units: 1, events: 1 },
        { productId: 'prod-1', source: 'OPERATOR', units: 2, events: 1 },
      ],
      { quantityDeltaSum: -9, movements: 5 },
      [],
    );
    expect(report.shrink.bySource).toEqual([
      { source: 'CV_DETECTED', units: 7, events: 4 },
      { source: 'OPERATOR', units: 2, events: 1 },
    ]);
    expect(report.shrink.byProduct[0]).toEqual({
      productId: 'prod-1',
      units: 8,
      events: 4,
    });
  });
});

describe('movement summary', () => {
  it('replays to the net change in stock over the window', () => {
    const summary = summariseMovements([
      { movementType: 'RECEIPT', quantityDeltaSum: 100, movements: 4 },
      { movementType: 'SALE', quantityDeltaSum: -60, movements: 30 },
      { movementType: 'SHRINK', quantityDeltaSum: -5, movements: 2 },
      { movementType: 'RETURN_IN', quantityDeltaSum: 3, movements: 1 },
    ]);
    expect(summary.totals.quantityDelta).toBe(38);
    expect(summary.totals.unitsIn).toBe(103);
    expect(summary.totals.unitsOut).toBe(65);
    expect(summary.totals.movements).toBe(37);
    expect(summary.byType.map((row) => row.movementType)).toEqual([
      'RECEIPT',
      'RETURN_IN',
      'SALE',
      'SHRINK',
    ]);
  });
});

describe('CV accuracy', () => {
  /**
   * The hand-built matrix this suite checks against.
   *
   *   6 x CORRECT       (PICKUP predicted, PICKUP expected, SKU right)
   *   2 x WRONG_SKU     (PICKUP predicted, PICKUP expected, SKU wrong)
   *   1 x INCORRECT     (PICKUP predicted, RETURN expected, SKU wrong)
   *   1 x WRONG_ACTION  (RETURN predicted, PICKUP expected)
   *   1 x FALSE_TOUCH   (PICKUP predicted, NO_OP expected)
   *   2 x UNCERTAIN     (excluded from every denominator)
   *   1 x MISSED_EVENT  (no prediction at all)
   *
   *   reviewed  = 6 + 2 + 1 + 1 + 1 + 2 = 13
   *   decided   = 13 - 2 uncertain      = 11
   *   action    = (6 + 2) / 11 = 0.727...  -> 0.727
   *   sku       = 6 / (6 + 2 + 1) = 0.666... -> 0.667
   *   combined  = 6 / 11 = 0.545...        -> 0.545
   */
  const groups: VerdictGroup[] = [
    {
      verdict: 'CORRECT',
      predictedAction: 'PICKUP',
      expectedAction: 'PICKUP',
      predictedSku: 'SKU-WATER',
      expectedSku: 'SKU-WATER',
      count: 6,
    },
    {
      verdict: 'WRONG_SKU',
      predictedAction: 'PICKUP',
      expectedAction: 'PICKUP',
      predictedSku: 'SKU-WATER',
      expectedSku: 'SKU-COFFEE',
      count: 2,
    },
    {
      verdict: 'INCORRECT',
      predictedAction: 'PICKUP',
      expectedAction: 'RETURN',
      predictedSku: 'SKU-WATER',
      expectedSku: 'SKU-COFFEE',
      count: 1,
    },
    {
      verdict: 'WRONG_ACTION',
      predictedAction: 'RETURN',
      expectedAction: 'PICKUP',
      predictedSku: null,
      expectedSku: null,
      count: 1,
    },
    {
      verdict: 'FALSE_TOUCH',
      predictedAction: 'PICKUP',
      expectedAction: 'NO_OP',
      predictedSku: null,
      expectedSku: null,
      count: 1,
    },
    {
      verdict: 'UNCERTAIN',
      predictedAction: 'PICKUP',
      expectedAction: 'UNKNOWN',
      predictedSku: 'SKU-WATER',
      expectedSku: null,
      count: 2,
    },
    {
      verdict: 'MISSED_EVENT',
      predictedAction: null,
      expectedAction: 'PICKUP',
      predictedSku: null,
      expectedSku: null,
      count: 1,
    },
  ];

  it('matches the hand-computed totals', () => {
    const report = buildCvAccuracy(groups);
    expect(report.totals).toEqual({
      reviewedObservations: 13,
      correct: 6,
      incorrect: 1,
      uncertain: 2,
      falseTouch: 1,
      wrongSku: 2,
      wrongAction: 1,
      missedEvents: 1,
      decided: 11,
    });
  });

  it('matches the hand-computed accuracy figures', () => {
    const report = buildCvAccuracy(groups);
    expect(report.accuracy.action).toBe(0.727);
    expect(report.accuracy.sku).toBe(0.667);
    expect(report.accuracy.combined).toBe(0.545);
  });

  it('matches the hand-computed confusion matrix', () => {
    const report = buildCvAccuracy(groups);
    const action = new Map(
      report.confusion.action.map((cell) => [
        `${cell.predicted}->${cell.expected}`,
        cell.count,
      ]),
    );
    // 6 CORRECT + 2 WRONG_SKU both land on PICKUP -> PICKUP (a WRONG_SKU had
    // the right action).
    expect(action.get('PICKUP->PICKUP')).toBe(8);
    expect(action.get('PICKUP->RETURN')).toBe(1);
    expect(action.get('RETURN->PICKUP')).toBe(1);
    expect(action.get('PICKUP->NO_OP')).toBe(1);
    // A missed interaction is a NO_OP prediction against a real PICKUP.
    expect(action.get('NO_OP->PICKUP')).toBe(1);
    // UNCERTAIN is in no cell at all.
    expect([...action.values()].reduce((a, b) => a + b, 0)).toBe(12);

    const sku = new Map(
      report.confusion.sku.map((cell) => [
        `${cell.predicted}->${cell.expected}`,
        cell.count,
      ]),
    );
    expect(sku.get('SKU-WATER->SKU-WATER')).toBe(6);
    expect(sku.get('SKU-WATER->SKU-COFFEE')).toBe(3);
    expect(sku.size).toBe(2);
  });

  it('returns null rather than a fabricated rate when nothing was decided', () => {
    const report = buildCvAccuracy([
      {
        verdict: 'UNCERTAIN',
        predictedAction: 'PICKUP',
        expectedAction: 'UNKNOWN',
        predictedSku: null,
        expectedSku: null,
        count: 3,
      },
    ]);
    expect(report.totals.decided).toBe(0);
    expect(report.accuracy.action).toBeNull();
    expect(report.accuracy.sku).toBeNull();
    expect(report.accuracy.combined).toBeNull();
  });

  it('never projects anything but verdicts, actions, SKUs and counts', () => {
    const serialised = JSON.stringify(buildCvAccuracy(groups));
    for (const leak of [
      'evidence',
      'storageKey',
      'visionEvent',
      'artifact',
      'notes',
      'mediaPath',
      'journeyEventId',
    ]) {
      expect(serialised.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe('report window', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('defaults to the trailing window ending now', () => {
    const resolved = resolveWindow({}, 30, now);
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) {
      return;
    }
    expect(resolved.to.toISOString()).toBe('2026-09-16T12:00:00.000Z');
    expect(resolved.from.toISOString()).toBe('2026-08-17T12:00:00.000Z');
  });

  it('rejects an inverted window instead of returning an empty report', () => {
    expect(
      resolveWindow(
        { from: '2026-09-16T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
        30,
        now,
      ),
    ).toEqual({ error: '`from` must be earlier than `to`' });
  });

  it('rejects an unparseable instant', () => {
    expect(resolveWindow({ to: 'not-a-date' }, 30, now)).toEqual({
      error: '`to` is not a valid ISO-8601 instant',
    });
  });
});
