/**
 * Phase 30 — the arithmetic every report is made of.
 *
 * Pure functions over rows the DATABASE has already aggregated. Nothing here
 * reads, writes, or knows about Prisma: the repository collapses millions of
 * order lines into a few hundred price points and a handful of grouped
 * counts, and these functions turn those into the numbers an operator reads.
 *
 * Two rules shape every function below.
 *
 *  1. A figure is either derivable from its inputs or it is null. No rate is
 *     invented when its denominator is zero, and no total is produced from a
 *     breakdown that had to be truncated.
 *  2. Numbers that mean different things are never added together. The two
 *     places that matters most are marked in the code: projection-vs-ledger
 *     DRIFT is never folded into cycle-count VARIANCE, and a damaged return
 *     (which writes no ledger movement at all) is never folded into SHRINK.
 */

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

/**
 * One PRICE POINT: every order line in the window that was sold at the same
 * money under the same price-book version and the same promotion version,
 * collapsed by the database into a single row.
 *
 * This grain is chosen on purpose. It is small (bounded by catalog x versions,
 * not by order count), it is what makes a sales figure EXPLAINABLE — each row
 * names the price version that set the base price and the promotion version
 * that took the discount off — and it is the only grain at which
 * `base - discount = unit` can be checked at all, because those columns are
 * per-unit while the totals are per-line.
 */
export interface SalesPricePoint {
  productId: string;
  sku: string;
  productName: string;
  currencyCode: string | null;
  priceBookVersionId: string | null;
  promotionVersionId: string | null;
  /** Per-unit price the price version said, before any promotion. */
  basePriceMinor: number | null;
  /** Per-unit amount the promotion version took off. */
  promotionDiscountMinor: number | null;
  /** Per-unit price the shopper actually paid. */
  unitPriceMinor: number | null;
  /** SUM(quantity) over the lines in this price point. */
  units: number;
  /** SUM(lineTotalMinor) over the lines in this price point. */
  lineTotalMinor: number | null;
  /** COUNT(*) of order lines in this price point. */
  lines: number;
}

export interface SalesPricePointMoney {
  /** basePriceMinor x units — what the price version alone would have taken. */
  grossSalesMinor: number;
  /** promotionDiscountMinor x units — what the promotion gave away. */
  promotionDiscountMinor: number;
  /** SUM(lineTotalMinor) — what was actually charged. */
  netSalesMinor: number;
}

export interface SalesCurrencyTotals extends SalesPricePointMoney {
  currencyCode: string;
  unitsSold: number;
  lines: number;
  /**
   * gross - discount === net. False means an order line's own snapshot
   * columns disagree with each other, which is a platform bug and is
   * surfaced, never smoothed over.
   */
  reconciled: boolean;
}

export interface SalesBreakdownRow extends SalesPricePointMoney {
  key: string;
  currencyCode: string;
  unitsSold: number;
  lines: number;
}

export interface SalesRollup {
  byCurrency: SalesCurrencyTotals[];
  byProduct: (SalesBreakdownRow & {
    productId: string;
    sku: string;
    productName: string;
  })[];
  byPromotionVersion: (SalesBreakdownRow & {
    promotionVersionId: string | null;
  })[];
  byPriceBookVersion: (SalesBreakdownRow & {
    priceBookVersionId: string | null;
  })[];
  /** Lines with no money on them at all (sold before pricing shipped). */
  unpricedLines: number;
  unpricedUnits: number;
  /**
   * Price points whose own columns do not satisfy
   * `base - discount = unit` or `unit x units = lineTotal`. Reported, not
   * corrected: reporting never edits domain data.
   */
  inconsistentPricePoints: number;
}

/** Per-unit money of one price point, resolved against the older shapes. */
function resolvePricePoint(row: SalesPricePoint): {
  money: SalesPricePointMoney;
  unpriced: boolean;
  inconsistent: boolean;
} {
  const unit = row.unitPriceMinor;
  if (unit === null && row.lineTotalMinor === null) {
    // Pre-pricing order line: NULL means UNPRICED, never free.
    return {
      money: { grossSalesMinor: 0, promotionDiscountMinor: 0, netSalesMinor: 0 },
      unpriced: true,
      inconsistent: false,
    };
  }
  const unitPrice = unit ?? 0;
  // Orders placed before Phase 29 carry no provenance columns. Their base
  // price IS what was charged, and the discount is zero — which keeps the
  // gross - discount = net identity true for them too.
  const base = row.basePriceMinor ?? unitPrice;
  const discount = row.promotionDiscountMinor ?? 0;
  const net = row.lineTotalMinor ?? unitPrice * row.units;
  return {
    money: {
      grossSalesMinor: base * row.units,
      promotionDiscountMinor: discount * row.units,
      netSalesMinor: net,
    },
    unpriced: false,
    inconsistent: base - discount !== unitPrice || net !== unitPrice * row.units,
  };
}

const UNKNOWN_CURRENCY = 'UNKNOWN';

function addMoney(
  target: SalesPricePointMoney,
  source: SalesPricePointMoney,
): void {
  target.grossSalesMinor += source.grossSalesMinor;
  target.promotionDiscountMinor += source.promotionDiscountMinor;
  target.netSalesMinor += source.netSalesMinor;
}

function emptyMoney(): SalesPricePointMoney {
  return { grossSalesMinor: 0, promotionDiscountMinor: 0, netSalesMinor: 0 };
}

interface Bucket extends SalesPricePointMoney {
  currencyCode: string;
  unitsSold: number;
  lines: number;
}

function bucketFor(
  buckets: Map<string, Bucket>,
  key: string,
  currencyCode: string,
): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { currencyCode, unitsSold: 0, lines: 0, ...emptyMoney() };
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * Roll price points up into the sales report.
 *
 * Currencies are never summed together: a price book never mixes currencies,
 * so two currencies in one window are two totals, not one meaningless sum.
 */
export function rollUpSales(rows: readonly SalesPricePoint[]): SalesRollup {
  const byCurrency = new Map<string, Bucket>();
  const byProduct = new Map<string, Bucket & { row: SalesPricePoint }>();
  const byPromotion = new Map<string, Bucket>();
  const byPriceVersion = new Map<string, Bucket>();
  let unpricedLines = 0;
  let unpricedUnits = 0;
  let inconsistentPricePoints = 0;

  for (const row of rows) {
    const { money, unpriced, inconsistent } = resolvePricePoint(row);
    if (unpriced) {
      unpricedLines += row.lines;
      unpricedUnits += row.units;
      continue;
    }
    if (inconsistent) {
      inconsistentPricePoints += 1;
    }
    const currency = row.currencyCode ?? UNKNOWN_CURRENCY;

    const currencyBucket = bucketFor(byCurrency, currency, currency);
    currencyBucket.unitsSold += row.units;
    currencyBucket.lines += row.lines;
    addMoney(currencyBucket, money);

    const productKey = `${currency}\u0000${row.productId}`;
    let productBucket = byProduct.get(productKey);
    if (!productBucket) {
      productBucket = {
        currencyCode: currency,
        unitsSold: 0,
        lines: 0,
        ...emptyMoney(),
        row,
      };
      byProduct.set(productKey, productBucket);
    }
    productBucket.unitsSold += row.units;
    productBucket.lines += row.lines;
    addMoney(productBucket, money);

    const promotionKey = `${currency}\u0000${row.promotionVersionId ?? ''}`;
    const promotionBucket = bucketFor(byPromotion, promotionKey, currency);
    promotionBucket.unitsSold += row.units;
    promotionBucket.lines += row.lines;
    addMoney(promotionBucket, money);

    const priceKey = `${currency}\u0000${row.priceBookVersionId ?? ''}`;
    const priceBucket = bucketFor(byPriceVersion, priceKey, currency);
    priceBucket.unitsSold += row.units;
    priceBucket.lines += row.lines;
    addMoney(priceBucket, money);
  }

  const byNetDesc = (a: { netSalesMinor: number }, b: { netSalesMinor: number }) =>
    b.netSalesMinor - a.netSalesMinor;

  return {
    byCurrency: [...byCurrency.values()]
      .map((bucket) => ({
        ...bucket,
        reconciled:
          bucket.grossSalesMinor - bucket.promotionDiscountMinor ===
          bucket.netSalesMinor,
      }))
      .sort(byNetDesc),
    byProduct: [...byProduct.entries()]
      .map(([key, bucket]) => {
        const { row, ...rest } = bucket;
        return {
          key,
          ...rest,
          productId: row.productId,
          sku: row.sku,
          productName: row.productName,
        };
      })
      .sort(byNetDesc),
    byPromotionVersion: [...byPromotion.entries()]
      .map(([key, bucket]) => ({
        key,
        ...bucket,
        promotionVersionId: key.split('\u0000')[1] || null,
      }))
      .sort(byNetDesc),
    byPriceBookVersion: [...byPriceVersion.entries()]
      .map(([key, bucket]) => ({
        key,
        ...bucket,
        priceBookVersionId: key.split('\u0000')[1] || null,
      }))
      .sort(byNetDesc),
    unpricedLines,
    unpricedUnits,
    inconsistentPricePoints,
  };
}

// ---------------------------------------------------------------------------
// Sales — one order, explained
// ---------------------------------------------------------------------------

export interface ExplainableOrderLine {
  quantity: number;
  basePriceMinor: number | null;
  promotionDiscountMinor: number | null;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
}

export interface OrderLineChecks {
  /** base - discount === unit. */
  unitPriceMatchesBaseMinusDiscount: boolean;
  /** unit x quantity === lineTotal. */
  lineTotalMatchesUnitTimesQuantity: boolean;
}

/**
 * The per-line arithmetic that makes ONE sale explainable: the price version
 * set `base`, the promotion version took `discount` off it, that is what the
 * shopper paid per unit, and that times the quantity is the line total. Both
 * halves are checked rather than asserted.
 */
export function checkOrderLine(line: ExplainableOrderLine): OrderLineChecks {
  const unit = line.unitPriceMinor;
  if (unit === null) {
    // Unpriced line: nothing to contradict, so nothing is claimed.
    return {
      unitPriceMatchesBaseMinusDiscount: line.basePriceMinor === null,
      lineTotalMatchesUnitTimesQuantity: line.lineTotalMinor === null,
    };
  }
  const base = line.basePriceMinor ?? unit;
  const discount = line.promotionDiscountMinor ?? 0;
  return {
    unitPriceMatchesBaseMinusDiscount: base - discount === unit,
    lineTotalMatchesUnitTimesQuantity:
      line.lineTotalMinor === unit * line.quantity,
  };
}

// ---------------------------------------------------------------------------
// Inventory — balances derived from the ledger
// ---------------------------------------------------------------------------

export interface LedgerBalanceRow {
  locationId: string;
  productId: string;
  /** SUM(quantityDelta) over the append-only ledger. The source of truth. */
  ledgerQuantity: number;
  movements: number;
}

export interface ProjectedBalanceRow {
  locationId: string;
  productId: string;
  quantity: number;
}

export interface BalanceRow extends LedgerBalanceRow {
  /** The InventoryLevel projection, shown only as a cross-check. */
  projectedQuantity: number | null;
  /**
   * projection - ledger. MUST be zero. A non-zero value means the projection
   * disagrees with its own history: a PLATFORM DEFECT, never stock variance.
   */
  projectionDriftQuantity: number | null;
}

export interface BalanceReportBody {
  rows: BalanceRow[];
  summary: {
    pairs: number;
    /** SUM of the ledger balances on this page. */
    ledgerQuantity: number;
    driftingPairs: number;
    totalAbsoluteDrift: number;
    projectionHealthy: boolean;
  };
}

/**
 * Join a page of ledger balances to the projection rows for the same pairs.
 *
 * The BALANCE reported is always the ledger one. The projection is shown
 * beside it so a disagreement is visible, and is never used as the answer —
 * that is what "the ledger is the source of truth" has to mean in a report.
 */
export function buildBalances(
  ledger: readonly LedgerBalanceRow[],
  projection: readonly ProjectedBalanceRow[],
): BalanceReportBody {
  const projected = new Map(
    projection.map((row) => [`${row.locationId}\u0000${row.productId}`, row.quantity]),
  );
  const rows: BalanceRow[] = ledger.map((row) => {
    const key = `${row.locationId}\u0000${row.productId}`;
    const projectedQuantity = projected.has(key) ? projected.get(key)! : null;
    return {
      ...row,
      projectedQuantity,
      projectionDriftQuantity:
        projectedQuantity === null ? null : projectedQuantity - row.ledgerQuantity,
    };
  });
  const drifting = rows.filter(
    (row) => row.projectionDriftQuantity !== null && row.projectionDriftQuantity !== 0,
  );
  return {
    rows,
    summary: {
      pairs: rows.length,
      ledgerQuantity: rows.reduce((total, row) => total + row.ledgerQuantity, 0),
      driftingPairs: drifting.length,
      totalAbsoluteDrift: drifting.reduce(
        (total, row) => total + Math.abs(row.projectionDriftQuantity ?? 0),
        0,
      ),
      projectionHealthy: drifting.length === 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Inventory — cycle counts: variance and drift, never mixed
// ---------------------------------------------------------------------------

export interface CountReconciliationInput {
  lines: number;
  /** SUM(counted - projected) — a real stock discrepancy. */
  varianceQuantitySum: number;
  varianceLines: number;
  /** SUM(projected - ledger) — a projection bug. */
  ledgerDriftQuantitySum: number;
  ledgerDriftLines: number;
}

export interface CountReconciliationReport {
  lines: number;
  /**
   * What an OPERATOR found: counted minus the projection. Every non-zero
   * value already became a signed CORRECTION_IN/CORRECTION_OUT movement.
   */
  variance: {
    totalQuantity: number;
    lines: number;
    meaning: string;
  };
  /**
   * What the PLATFORM got wrong: the projection minus its own ledger replay.
   * Kept in its own block with its own total. Phase 27 refused to fold this
   * into the operator's variance and this report refuses too — averaging a
   * platform defect into a stock discrepancy hides both.
   */
  projectionDefect: {
    totalDriftQuantity: number;
    lines: number;
    healthy: boolean;
    meaning: string;
    severity: 'NONE' | 'PLATFORM_DEFECT';
  };
  /** Restated in the payload so no consumer can add the two by accident. */
  varianceIncludesDrift: false;
}

export function buildCountReconciliation(
  input: CountReconciliationInput,
): CountReconciliationReport {
  return {
    lines: input.lines,
    variance: {
      totalQuantity: input.varianceQuantitySum,
      lines: input.varianceLines,
      meaning:
        'counted minus projected — a stock discrepancy an operator found; ' +
        'each non-zero line became a signed ledger correction',
    },
    projectionDefect: {
      totalDriftQuantity: input.ledgerDriftQuantitySum,
      lines: input.ledgerDriftLines,
      healthy: input.ledgerDriftLines === 0,
      meaning:
        'projected minus the ledger replay — MUST be zero; a non-zero value ' +
        'is a platform defect, not stock variance, and was never corrected ' +
        'by the count',
      severity: input.ledgerDriftLines === 0 ? 'NONE' : 'PLATFORM_DEFECT',
    },
    varianceIncludesDrift: false,
  };
}

// ---------------------------------------------------------------------------
// Shrink
// ---------------------------------------------------------------------------

export interface ShrinkGroup {
  productId: string;
  source: string;
  units: number;
  events: number;
}

export interface DamagedReturnGroup {
  productId: string;
  units: number;
  lines: number;
}

export interface ShrinkReportBody {
  shrink: {
    units: number;
    events: number;
    bySource: { source: string; units: number; events: number }[];
    byProduct: { productId: string; units: number; events: number }[];
  };
  /**
   * The SHRINK movements the ledger actually carries in the same window.
   * A ShrinkEvent without its movement would be a stock claim with no
   * history, so the two are compared instead of trusted.
   */
  ledgerCheck: {
    shrinkMovementUnits: number;
    movements: number;
    reconciled: boolean;
  };
  /**
   * Damaged/unsellable returns. Counted SEPARATELY and never added to shrink:
   * a damaged return deliberately writes NO ledger movement (the goods never
   * went back on the shelf and were never written off), so folding it into a
   * shrink total would invent stock movement that never happened.
   */
  damagedReturns: {
    units: number;
    lines: number;
    byProduct: DamagedReturnGroup[];
    ledgerMovementsWritten: 0;
    meaning: string;
  };
}

export function buildShrinkReport(
  groups: readonly ShrinkGroup[],
  ledger: { quantityDeltaSum: number; movements: number },
  damaged: readonly DamagedReturnGroup[],
): ShrinkReportBody {
  const bySourceMap = new Map<string, { units: number; events: number }>();
  const byProductMap = new Map<string, { units: number; events: number }>();
  let units = 0;
  let events = 0;
  for (const group of groups) {
    units += group.units;
    events += group.events;
    const source = bySourceMap.get(group.source) ?? { units: 0, events: 0 };
    source.units += group.units;
    source.events += group.events;
    bySourceMap.set(group.source, source);
    const product = byProductMap.get(group.productId) ?? { units: 0, events: 0 };
    product.units += group.units;
    product.events += group.events;
    byProductMap.set(group.productId, product);
  }
  // SHRINK movements are negative deltas; the report speaks in units lost.
  const shrinkMovementUnits = -ledger.quantityDeltaSum;
  return {
    shrink: {
      units,
      events,
      bySource: [...bySourceMap.entries()]
        .map(([source, totals]) => ({ source, ...totals }))
        .sort((a, b) => b.units - a.units),
      byProduct: [...byProductMap.entries()]
        .map(([productId, totals]) => ({ productId, ...totals }))
        .sort((a, b) => b.units - a.units),
    },
    ledgerCheck: {
      shrinkMovementUnits,
      movements: ledger.movements,
      reconciled: shrinkMovementUnits === units,
    },
    damagedReturns: {
      units: damaged.reduce((total, row) => total + row.units, 0),
      lines: damaged.reduce((total, row) => total + row.lines, 0),
      byProduct: [...damaged].sort((a, b) => b.units - a.units),
      ledgerMovementsWritten: 0,
      meaning:
        'returned goods that did not go back on the shelf. A damaged return ' +
        'writes NO ledger movement, so it is not shrink and is never added ' +
        'to the shrink total',
    },
  };
}

// ---------------------------------------------------------------------------
// CV accuracy
// ---------------------------------------------------------------------------

/**
 * One grouped count of LATEST operator verdicts. The database did the
 * "newest review per observation" selection; this is what survived it.
 *
 * Note what is NOT in this row, and cannot be: no evidence bundle, no vision
 * event id, no media key, no storage path, no crop artifact, no reviewer
 * note. A CV-accuracy report is counts of verdicts and catalog SKUs — the
 * numbers, never the pictures.
 */
export interface VerdictGroup {
  verdict: string;
  predictedAction: string | null;
  expectedAction: string;
  predictedSku: string | null;
  expectedSku: string | null;
  count: number;
}

export interface ConfusionCell {
  predicted: string;
  expected: string;
  count: number;
}

export interface CvAccuracyReportBody {
  totals: {
    reviewedObservations: number;
    correct: number;
    incorrect: number;
    uncertain: number;
    falseTouch: number;
    wrongSku: number;
    wrongAction: number;
    missedEvents: number;
    decided: number;
  };
  accuracy: {
    action: number | null;
    sku: number | null;
    combined: number | null;
  };
  confusion: {
    action: ConfusionCell[];
    sku: ConfusionCell[];
  };
  definitions: Record<string, string>;
}

const MISSED_EVENT = 'MISSED_EVENT';
const CORRECT = 'CORRECT';
const INCORRECT = 'INCORRECT';
const UNCERTAIN = 'UNCERTAIN';
const FALSE_TOUCH = 'FALSE_TOUCH';
const WRONG_SKU = 'WRONG_SKU';
const WRONG_ACTION = 'WRONG_ACTION';
const NO_OP = 'NO_OP';
const UNKNOWN_SKU = 'UNKNOWN';

/** Three decimal places, and null rather than a fabricated rate at 0/0. */
function rate(numerator: number, denominator: number): number | null {
  return denominator > 0
    ? Math.round((numerator / denominator) * 1000) / 1000
    : null;
}

function addCell(
  cells: Map<string, number>,
  predicted: string,
  expected: string,
  count: number,
): void {
  const key = `${predicted}\u0000${expected}`;
  cells.set(key, (cells.get(key) ?? 0) + count);
}

function toMatrix(cells: Map<string, number>): ConfusionCell[] {
  return [...cells.entries()]
    .map(([key, count]) => {
      const [predicted, expected] = key.split('\u0000');
      return { predicted, expected, count };
    })
    .sort((a, b) =>
      b.count - a.count ||
      a.predicted.localeCompare(b.predicted) ||
      a.expected.localeCompare(b.expected),
    );
}

/**
 * Accuracy and confusion over the latest verdict per observation.
 *
 * The definitions are pinned to the ones the pilot-evaluation summary already
 * uses, so the two surfaces can never quote different accuracies for the same
 * run:
 *  - decided excludes UNCERTAIN and MISSED_EVENT;
 *  - action accuracy = (CORRECT + WRONG_SKU) / decided, because WRONG_SKU
 *    means the ACTION was right;
 *  - sku accuracy = CORRECT / (CORRECT + WRONG_SKU + INCORRECT), over
 *    observations that carried a predicted SKU;
 *  - combined accuracy = CORRECT / decided;
 *  - every rate is null when its denominator is 0.
 */
export function buildCvAccuracy(
  groups: readonly VerdictGroup[],
): CvAccuracyReportBody {
  const totals = {
    reviewedObservations: 0,
    correct: 0,
    incorrect: 0,
    uncertain: 0,
    falseTouch: 0,
    wrongSku: 0,
    wrongAction: 0,
    missedEvents: 0,
    decided: 0,
  };
  const actionCells = new Map<string, number>();
  const skuCells = new Map<string, number>();
  let skuJudged = 0;
  let skuCorrect = 0;

  for (const group of groups) {
    if (group.verdict === MISSED_EVENT) {
      // A missed interaction is not a wrong prediction — there was no
      // prediction. It is its own total and its own confusion row.
      totals.missedEvents += group.count;
      addCell(actionCells, NO_OP, group.expectedAction, group.count);
      continue;
    }
    totals.reviewedObservations += group.count;
    switch (group.verdict) {
      case CORRECT:
        totals.correct += group.count;
        break;
      case INCORRECT:
        totals.incorrect += group.count;
        break;
      case UNCERTAIN:
        totals.uncertain += group.count;
        break;
      case FALSE_TOUCH:
        totals.falseTouch += group.count;
        break;
      case WRONG_SKU:
        totals.wrongSku += group.count;
        break;
      case WRONG_ACTION:
        totals.wrongAction += group.count;
        break;
      default:
        break;
    }
    if (group.verdict === UNCERTAIN) {
      // Unscored: an operator who could not tell is not evidence either way.
      continue;
    }
    const predictedAction = group.predictedAction ?? NO_OP;
    // For a CORRECT verdict the expectation IS the prediction.
    const expectedAction =
      group.verdict === CORRECT ? predictedAction : group.expectedAction;
    addCell(actionCells, predictedAction, expectedAction, group.count);

    if (group.predictedSku) {
      if (group.verdict === CORRECT) {
        skuJudged += group.count;
        skuCorrect += group.count;
        addCell(skuCells, group.predictedSku, group.predictedSku, group.count);
      } else if (group.verdict === WRONG_SKU || group.verdict === INCORRECT) {
        skuJudged += group.count;
        addCell(
          skuCells,
          group.predictedSku,
          group.expectedSku ?? UNKNOWN_SKU,
          group.count,
        );
      }
    }
  }
  totals.decided = totals.reviewedObservations - totals.uncertain;

  return {
    totals,
    accuracy: {
      action: rate(totals.correct + totals.wrongSku, totals.decided),
      sku: rate(skuCorrect, skuJudged),
      combined: rate(totals.correct, totals.decided),
    },
    confusion: { action: toMatrix(actionCells), sku: toMatrix(skuCells) },
    definitions: {
      decided: 'reviewed observations excluding UNCERTAIN and MISSED_EVENT',
      action: '(CORRECT + WRONG_SKU) / decided — WRONG_SKU had the right action',
      sku: 'CORRECT / (CORRECT + WRONG_SKU + INCORRECT) where a SKU was predicted',
      combined: 'CORRECT / decided',
      nullRate: 'a rate is null when its denominator is 0 — never fabricated',
    },
  };
}

// ---------------------------------------------------------------------------
// Movement summary
// ---------------------------------------------------------------------------

export interface MovementGroup {
  movementType: string;
  quantityDeltaSum: number;
  movements: number;
}

export interface MovementSummary {
  byType: {
    movementType: string;
    quantityDelta: number;
    unitsIn: number;
    unitsOut: number;
    movements: number;
  }[];
  totals: {
    quantityDelta: number;
    unitsIn: number;
    unitsOut: number;
    movements: number;
  };
}

/**
 * Movements in the window, by type. `quantityDelta` is the signed net change
 * the ledger recorded, so the totals replay to exactly the change in on-hand
 * stock over the window — no interpretation layer in between.
 */
export function summariseMovements(
  groups: readonly MovementGroup[],
): MovementSummary {
  const byType = [...groups]
    .map((group) => ({
      movementType: group.movementType,
      quantityDelta: group.quantityDeltaSum,
      unitsIn: group.quantityDeltaSum > 0 ? group.quantityDeltaSum : 0,
      unitsOut: group.quantityDeltaSum < 0 ? -group.quantityDeltaSum : 0,
      movements: group.movements,
    }))
    .sort((a, b) => a.movementType.localeCompare(b.movementType));
  return {
    byType,
    totals: {
      quantityDelta: byType.reduce((total, row) => total + row.quantityDelta, 0),
      unitsIn: byType.reduce((total, row) => total + row.unitsIn, 0),
      unitsOut: byType.reduce((total, row) => total + row.unitsOut, 0),
      movements: byType.reduce((total, row) => total + row.movements, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Window resolution
// ---------------------------------------------------------------------------

export interface ResolvedWindow {
  from: Date;
  to: Date;
}

/**
 * Resolve the reporting window. Both ends are echoed back in every report so
 * a number can never be read without knowing what period it covers.
 */
export function resolveWindow(
  input: { from?: string; to?: string },
  defaultDays: number,
  now: Date = new Date(),
): ResolvedWindow | { error: string } {
  const to = input.to ? new Date(input.to) : now;
  if (Number.isNaN(to.getTime())) {
    return { error: '`to` is not a valid ISO-8601 instant' };
  }
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime())) {
    return { error: '`from` is not a valid ISO-8601 instant' };
  }
  if (from.getTime() >= to.getTime()) {
    return { error: '`from` must be earlier than `to`' };
  }
  return { from, to };
}
