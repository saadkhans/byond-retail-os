import { GoodsReceiptDiscrepancy, PurchaseOrderStatus } from '@prisma/client';
import {
  derivePurchaseOrderStatus,
  isCurrencyCode,
  nextReference,
  normalizeCurrencyCode,
  normalizeSupplierCode,
  normalizeSupplierSku,
  orderTotalMinor,
  receivedPacksByLine,
  suggestDiscrepancy,
  unitsForPacks,
} from './procurement.logic';

const line = (
  id: string,
  quantityOrdered: number,
  packSize = 1,
  unitCostMinor = 0,
) => ({ id, quantityOrdered, packSize, unitCostMinor });

describe('normalization', () => {
  it('uppercases supplier codes the way SKUs are normalized', () => {
    expect(normalizeSupplierCode('  gulf-foods ')).toBe('GULF-FOODS');
  });

  it('trims a supplier SKU but preserves its case, because it is theirs', () => {
    expect(normalizeSupplierSku('  aB-12/x ')).toBe('aB-12/x');
  });

  it('uppercases currency codes and recognises ISO-4217 shapes', () => {
    expect(normalizeCurrencyCode(' aed ')).toBe('AED');
    expect(isCurrencyCode('AED')).toBe(true);
    expect(isCurrencyCode('AE')).toBe(false);
    expect(isCurrencyCode('aed')).toBe(false);
  });
});

describe('unitsForPacks', () => {
  it('multiplies packs by pack size with no floating point', () => {
    expect(unitsForPacks(3, 12)).toBe(36);
    expect(unitsForPacks(0, 12)).toBe(0);
  });
});

describe('receivedPacksByLine', () => {
  it('reports zero for a line nothing has arrived against', () => {
    const received = receivedPacksByLine([line('l1', 5)], []);
    expect(received.get('l1')).toBe(0);
  });

  it('sums across every receipt posted against the line', () => {
    const received = receivedPacksByLine(
      [line('l1', 10), line('l2', 4)],
      [
        { purchaseOrderLineId: 'l1', quantityReceived: 3 },
        { purchaseOrderLineId: 'l1', quantityReceived: 4 },
        { purchaseOrderLineId: 'l2', quantityReceived: 4 },
      ],
    );
    expect(received.get('l1')).toBe(7);
    expect(received.get('l2')).toBe(4);
  });

  it('ignores receipt lines that belong to another order', () => {
    const received = receivedPacksByLine(
      [line('l1', 10)],
      [
        { purchaseOrderLineId: 'l1', quantityReceived: 2 },
        { purchaseOrderLineId: 'somebody-elses-line', quantityReceived: 99 },
      ],
    );
    expect(received.get('l1')).toBe(2);
    expect(received.size).toBe(1);
  });
});

describe('derivePurchaseOrderStatus', () => {
  const lines = [line('l1', 10), line('l2', 5)];

  it('stays SUBMITTED while nothing has arrived', () => {
    const received = receivedPacksByLine(lines, []);
    expect(
      derivePurchaseOrderStatus(
        PurchaseOrderStatus.SUBMITTED,
        lines,
        received,
      ),
    ).toBe(PurchaseOrderStatus.SUBMITTED);
  });

  it('becomes PARTIALLY_RECEIVED once some of it arrives', () => {
    const received = receivedPacksByLine(lines, [
      { purchaseOrderLineId: 'l1', quantityReceived: 4 },
    ]);
    expect(
      derivePurchaseOrderStatus(
        PurchaseOrderStatus.SUBMITTED,
        lines,
        received,
      ),
    ).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED);
  });

  it('becomes RECEIVED only when every line is satisfied', () => {
    const received = receivedPacksByLine(lines, [
      { purchaseOrderLineId: 'l1', quantityReceived: 10 },
      { purchaseOrderLineId: 'l2', quantityReceived: 5 },
    ]);
    expect(
      derivePurchaseOrderStatus(
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
        lines,
        received,
      ),
    ).toBe(PurchaseOrderStatus.RECEIVED);
  });

  it('treats an over-delivered line as satisfied, not still partial', () => {
    const received = receivedPacksByLine(lines, [
      { purchaseOrderLineId: 'l1', quantityReceived: 12 },
      { purchaseOrderLineId: 'l2', quantityReceived: 5 },
    ]);
    expect(
      derivePurchaseOrderStatus(
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
        lines,
        received,
      ),
    ).toBe(PurchaseOrderStatus.RECEIVED);
  });

  it('never revives a cancelled order, whatever arrives', () => {
    const received = receivedPacksByLine(lines, [
      { purchaseOrderLineId: 'l1', quantityReceived: 10 },
      { purchaseOrderLineId: 'l2', quantityReceived: 5 },
    ]);
    expect(
      derivePurchaseOrderStatus(
        PurchaseOrderStatus.CANCELLED,
        lines,
        received,
      ),
    ).toBe(PurchaseOrderStatus.CANCELLED);
  });

  it('leaves a draft order alone — it is not receivable yet', () => {
    expect(
      derivePurchaseOrderStatus(
        PurchaseOrderStatus.DRAFT,
        lines,
        receivedPacksByLine(lines, []),
      ),
    ).toBe(PurchaseOrderStatus.DRAFT);
  });

  it('is a pure function of the receipts, so replaying lands identically', () => {
    const receipts = [
      { purchaseOrderLineId: 'l1', quantityReceived: 6 },
      { purchaseOrderLineId: 'l2', quantityReceived: 5 },
    ];
    const once = derivePurchaseOrderStatus(
      PurchaseOrderStatus.SUBMITTED,
      lines,
      receivedPacksByLine(lines, receipts),
    );
    const again = derivePurchaseOrderStatus(
      PurchaseOrderStatus.SUBMITTED,
      lines,
      receivedPacksByLine(lines, receipts),
    );
    expect(once).toBe(again);
  });
});

describe('orderTotalMinor', () => {
  it('sums packs times cost per pack, integer-exact', () => {
    expect(
      orderTotalMinor([line('l1', 3, 12, 1099), line('l2', 2, 6, 550)]),
    ).toBe(3 * 1099 + 2 * 550);
  });

  it('is zero for an order with no lines', () => {
    expect(orderTotalMinor([])).toBe(0);
  });
});

describe('suggestDiscrepancy', () => {
  it('reports a short delivery while the running total is behind', () => {
    expect(suggestDiscrepancy(10, 0, 4)).toBe(
      GoodsReceiptDiscrepancy.SHORT_DELIVERY,
    );
  });

  it('reports nothing wrong once the running total completes the line', () => {
    expect(suggestDiscrepancy(10, 6, 4)).toBe(GoodsReceiptDiscrepancy.NONE);
  });

  it('does not call the last of several partial deliveries short', () => {
    expect(suggestDiscrepancy(10, 7, 3)).toBe(GoodsReceiptDiscrepancy.NONE);
  });

  it('reports an over delivery when more arrives than was ordered', () => {
    expect(suggestDiscrepancy(10, 9, 3)).toBe(
      GoodsReceiptDiscrepancy.OVER_DELIVERY,
    );
  });
});

describe('nextReference', () => {
  it('starts a year at 0001', () => {
    expect(nextReference('PO', 2026, null)).toBe('PO-2026-0001');
  });

  it('increments the highest reference in the same year', () => {
    expect(nextReference('PO', 2026, 'PO-2026-0041')).toBe('PO-2026-0042');
  });

  it('restarts when the latest reference belongs to another year', () => {
    expect(nextReference('PO', 2027, 'PO-2026-0041')).toBe('PO-2027-0001');
  });

  it('ignores a reference that does not match the sequence shape', () => {
    expect(nextReference('GR', 2026, 'legacy-import-7')).toBe('GR-2026-0001');
  });
});
