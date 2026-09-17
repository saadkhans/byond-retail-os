import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  ACTOR,
  buildHarness,
  Harness,
  OTHER_TENANT,
  TENANT,
} from '../../test/procurement-harness';

async function submittedOrder(
  h: Harness,
  lines: { productId: string; quantityOrdered: number; packSize?: number }[] = [
    { productId: 'prod-a', quantityOrdered: 10, packSize: 12 },
  ],
): Promise<{ orderId: string; lineIds: string[] }> {
  const supplier = await h.service.createSupplier(
    TENANT,
    { code: `acme-${h.rows.suppliers.length}`, name: 'Acme Trading' },
    ACTOR,
  );
  const order = await h.service.createPurchaseOrder(
    TENANT,
    {
      supplierId: supplier.id,
      locationId: 'store-1',
      currencyCode: 'AED',
      lines: lines.map((line) => ({ unitCostMinor: 1099, ...line })),
    },
    ACTOR,
  );
  const submitted = await h.service.submitPurchaseOrder(
    TENANT,
    order.id,
    {},
    ACTOR,
  );
  return {
    orderId: submitted.id,
    lineIds: submitted.lines.map((line) => line.id),
  };
}

describe('suppliers', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('normalizes the code and records who created it', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: ' gulf-foods ', name: '  Gulf Foods  ' },
      ACTOR,
    );
    expect(supplier.code).toBe('GULF-FOODS');
    expect(supplier.name).toBe('Gulf Foods');
    expect(h.rows.audits.some((a) => a.entityType === 'Supplier')).toBe(true);
  });

  it('rejects a duplicate code within the tenant', async () => {
    await h.service.createSupplier(TENANT, { code: 'ACME', name: 'A' }, ACTOR);
    await expect(
      h.service.createSupplier(TENANT, { code: 'acme', name: 'B' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets a different tenant use the same code', async () => {
    await h.service.createSupplier(TENANT, { code: 'ACME', name: 'A' }, ACTOR);
    await expect(
      h.service.createSupplier(
        OTHER_TENANT,
        { code: 'ACME', name: 'B' },
        ACTOR,
      ),
    ).resolves.toMatchObject({ code: 'ACME' });
  });

  it('never reads a supplier belonging to another tenant', async () => {
    const mine = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'A' },
      ACTOR,
    );
    await expect(
      h.service.findSupplierById(OTHER_TENANT, mine.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never updates a supplier belonging to another tenant', async () => {
    const mine = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'A' },
      ACTOR,
    );
    await expect(
      h.service.updateSupplier(OTHER_TENANT, mine.id, { name: 'X' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.rows.suppliers[0].name).toBe('A');
  });

  it('refuses free text that carries payment-shaped values', async () => {
    await expect(
      h.service.createSupplier(
        TENANT,
        { code: 'ACME', name: 'A', notes: 'card 4111 1111 1111 1111' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // The tenant has to be IN the write predicate, not merely proven by the
  // lookup that preceded it — the rule LocationsRepository was corrected to
  // follow after a Codex P1 finding. The harness fails any update that omits
  // the composite key, so every other update path is covered too; this pins
  // the shape explicitly.
  it('updates through the id_tenantId composite key', async () => {
    const mine = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'A' },
      ACTOR,
    );
    await h.service.updateSupplier(TENANT, mine.id, { name: 'Renamed' }, ACTOR);
    expect(h.prisma.supplier.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: mine.id, tenantId: TENANT } },
      }),
    );
  });
});

describe('supplier costs are appended, never overwritten silently', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('records a history row on first link and on every change', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    await h.service.upsertSupplierProduct(
      TENANT,
      supplier.id,
      {
        productId: 'prod-a',
        supplierSku: 'ACME-A',
        packSize: 12,
        unitCostMinor: 1000,
        currencyCode: 'aed',
      },
      ACTOR,
    );
    await h.service.upsertSupplierProduct(
      TENANT,
      supplier.id,
      {
        productId: 'prod-a',
        supplierSku: 'ACME-A',
        packSize: 12,
        unitCostMinor: 1200,
        currencyCode: 'AED',
        reason: 'Annual increase',
      },
      ACTOR,
    );
    expect(h.rows.supplierProductCosts).toHaveLength(2);
    expect(h.rows.supplierProductCosts.map((c) => c.unitCostMinor)).toEqual([
      1000, 1200,
    ]);
    expect(h.rows.supplierProducts).toHaveLength(1);
    expect(h.rows.supplierProducts[0].unitCostMinor).toBe(1200);
  });

  it('does not append a history row when nothing about the cost changed', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    const payload = {
      productId: 'prod-a',
      supplierSku: 'ACME-A',
      packSize: 12,
      unitCostMinor: 1000,
      currencyCode: 'AED',
    };
    await h.service.upsertSupplierProduct(TENANT, supplier.id, payload, ACTOR);
    await h.service.upsertSupplierProduct(TENANT, supplier.id, payload, ACTOR);
    expect(h.rows.supplierProductCosts).toHaveLength(1);
  });

  it('refuses a product from another tenant', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    await expect(
      h.service.upsertSupplierProduct(
        TENANT,
        supplier.id,
        {
          productId: 'prod-foreign',
          supplierSku: 'X',
          unitCostMinor: 1,
          currencyCode: 'AED',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('purchase order lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('allocates a sequential reference and starts in DRAFT', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    const first = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 5 }],
      },
      ACTOR,
    );
    const second = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-b', quantityOrdered: 5 }],
      },
      ACTOR,
    );
    expect(first.status).toBe('DRAFT');
    expect(first.reference).toMatch(/^PO-\d{4}-0001$/);
    expect(second.reference).toMatch(/^PO-\d{4}-0002$/);
  });

  it('takes pack size and cost from the supplier catalog when not overridden', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    await h.service.upsertSupplierProduct(
      TENANT,
      supplier.id,
      {
        productId: 'prod-a',
        supplierSku: 'ACME-A',
        packSize: 24,
        unitCostMinor: 999,
        currencyCode: 'AED',
      },
      ACTOR,
    );
    const order = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 3 }],
      },
      ACTOR,
    );
    expect(order.lines[0]).toMatchObject({ packSize: 24, unitCostMinor: 999 });
    expect(order.computedTotalMinor).toBe(3 * 999);
  });

  it('rejects the same product twice on one order', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    await expect(
      h.service.createPurchaseOrder(
        TENANT,
        {
          supplierId: supplier.id,
          locationId: 'store-1',
          currencyCode: 'AED',
          lines: [
            { productId: 'prod-a', quantityOrdered: 1 },
            { productId: 'prod-a', quantityOrdered: 2 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a location from another tenant', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    await expect(
      h.service.createPurchaseOrder(
        TENANT,
        {
          supplierId: supplier.id,
          locationId: 'store-9',
          currencyCode: 'AED',
          lines: [{ productId: 'prod-a', quantityOrdered: 1 }],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stamps the total and the acknowledgement on submission', async () => {
    const { orderId } = await submittedOrder(h);
    const order = await h.service.findPurchaseOrderById(TENANT, orderId);
    expect(order.status).toBe('SUBMITTED');
    expect(order.totalCostMinor).toBe(10 * 1099);
    expect(order.externalReference).toMatch(/^SIM-/);
  });

  it('quotes the supplier their OWN sku, not ours, when they list the product', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    await h.service.upsertSupplierProduct(
      TENANT,
      supplier.id,
      {
        productId: 'prod-a',
        supplierSku: 'ACME-991',
        packSize: 12,
        unitCostMinor: 1099,
        currencyCode: 'AED',
      },
      ACTOR,
    );
    const order = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 2 }],
      },
      ACTOR,
    );
    await h.service.submitPurchaseOrder(TENANT, order.id, {}, ACTOR);
    const request = h.supplierAdapter.submitOrder.mock.calls[0][0] as {
      lines: { supplierSku: string; sku: string }[];
    };
    expect(request.lines[0].supplierSku).toBe('ACME-991');
    expect(request.lines[0].sku).toBe('SKU-A');
  });

  it('falls back to our sku for a product the supplier does not list', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    const order = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 2 }],
      },
      ACTOR,
    );
    await h.service.submitPurchaseOrder(TENANT, order.id, {}, ACTOR);
    const request = h.supplierAdapter.submitOrder.mock.calls[0][0] as {
      lines: { supplierSku: string }[];
    };
    expect(request.lines[0].supplierSku).toBe('SKU-A');
  });

  it('records a submission made outside the system without calling the adapter', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    const order = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 1 }],
      },
      ACTOR,
    );
    const submitted = await h.service.submitPurchaseOrder(
      TENANT,
      order.id,
      { sendToSupplier: false },
      ACTOR,
    );
    expect(h.supplierAdapter.submitOrder).not.toHaveBeenCalled();
    expect(submitted.externalReference).toBeNull();
  });

  it('leaves the order in DRAFT when the supplier rejects it', async () => {
    h.supplierAdapter.submitOrder.mockResolvedValueOnce({
      status: 'REJECTED',
      failure: 'SUPPLIER_UNREACHABLE',
    });
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    const order = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 1 }],
      },
      ACTOR,
    );
    await expect(
      h.service.submitPurchaseOrder(TENANT, order.id, {}, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    const after = await h.service.findPurchaseOrderById(TENANT, order.id);
    expect(after.status).toBe('DRAFT');
  });

  it('refuses to submit an order twice', async () => {
    const { orderId } = await submittedOrder(h);
    await expect(
      h.service.submitPurchaseOrder(TENANT, orderId, {}, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancels a submitted order with a stated reason', async () => {
    const { orderId } = await submittedOrder(h);
    const cancelled = await h.service.cancelPurchaseOrder(
      TENANT,
      orderId,
      { reason: 'Supplier out of stock' },
      ACTOR,
    );
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.closedAt).not.toBeNull();
  });

  it('refuses to cancel an order that is already fully received', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 10 }] },
      ACTOR,
    );
    await expect(
      h.service.cancelPurchaseOrder(TENANT, orderId, { reason: 'too late' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never exposes an order from another tenant', async () => {
    const { orderId } = await submittedOrder(h);
    await expect(
      h.service.findPurchaseOrderById(OTHER_TENANT, orderId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('receiving reaches stock only through the inventory ledger', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('writes a RECEIPT movement of packs x pack size', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 3 }] },
      ACTOR,
    );
    expect(h.rows.movements).toHaveLength(1);
    expect(h.rows.movements[0]).toMatchObject({
      movementType: 'RECEIPT',
      quantityDelta: 36,
      locationId: 'store-1',
      productId: 'prod-a',
      referenceType: 'GoodsReceipt',
    });
  });

  it('keeps the projection equal to a replay of the ledger', async () => {
    const { orderId, lineIds } = await submittedOrder(h, [
      { productId: 'prod-a', quantityOrdered: 10, packSize: 12 },
      { productId: 'prod-b', quantityOrdered: 4, packSize: 6 },
    ]);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      {
        lines: [
          { purchaseOrderLineId: lineIds[0], quantityReceived: 4 },
          { purchaseOrderLineId: lineIds[1], quantityReceived: 2 },
        ],
      },
      ACTOR,
    );
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 6 }] },
      ACTOR,
    );
    expect(Object.fromEntries(h.replayLedger())).toEqual(
      Object.fromEntries(h.levels),
    );
    expect(h.levels.get('store-1:prod-a')).toBe(10 * 12);
  });

  it('writes no movement for a line that received nothing', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    const receipt = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 0 }] },
      ACTOR,
    );
    expect(h.rows.movements).toHaveLength(0);
    expect(receipt.lines[0].inventoryMovementId).toBeNull();
    expect(receipt.lines[0].unitsReceived).toBe(0);
  });

  it('links every receipt line to the exact movement it produced', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    const receipt = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 2 }] },
      ACTOR,
    );
    expect(receipt.lines[0].inventoryMovementId).toBe(h.rows.movements[0].id);
    const movements = await h.service.findReceiptMovements(TENANT, receipt.id);
    expect(movements).toHaveLength(1);
    expect(movements[0].quantityAfter).toBe(24);
  });

  it('derives received quantities from receipts rather than a stored counter', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 4 }] },
      ACTOR,
    );
    const order = await h.service.findPurchaseOrderById(TENANT, orderId);
    expect(order.lines[0].quantityReceived).toBe(4);
    expect(order.lines[0].quantityOutstanding).toBe(6);
    expect(order.lines[0].unitsReceived).toBe(48);
    expect(order.status).toBe('PARTIALLY_RECEIVED');
    // The stored line row carries no received field at all.
    expect(h.rows.purchaseOrderLines[0].quantityReceived).toBeUndefined();
  });

  it('moves the order to RECEIVED once every line is satisfied', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 10 }] },
      ACTOR,
    );
    const order = await h.service.findPurchaseOrderById(TENANT, orderId);
    expect(order.status).toBe('RECEIVED');
    expect(order.closedAt).not.toBeNull();
  });

  it('labels a short delivery and then clears it when the rest arrives', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    const first = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 4 }] },
      ACTOR,
    );
    expect(first.lines[0].discrepancy).toBe('SHORT_DELIVERY');
    const second = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 6 }] },
      ACTOR,
    );
    expect(second.lines[0].discrepancy).toBe('NONE');
  });

  it('labels an over delivery and still stocks what arrived', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    const receipt = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 12 }] },
      ACTOR,
    );
    expect(receipt.lines[0].discrepancy).toBe('OVER_DELIVERY');
    expect(h.levels.get('store-1:prod-a')).toBe(12 * 12);
  });

  it('never overrules an operator who states a reason of their own', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    const receipt = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      {
        lines: [
          {
            purchaseOrderLineId: lineIds[0],
            quantityReceived: 4,
            discrepancy: 'DAMAGED',
            discrepancyNote: 'Six packs crushed in transit',
          },
        ],
      },
      ACTOR,
    );
    expect(receipt.lines[0].discrepancy).toBe('DAMAGED');
  });

  it('refuses to receive against a DRAFT order', async () => {
    const supplier = await h.service.createSupplier(
      TENANT,
      { code: 'ACME', name: 'Acme' },
      ACTOR,
    );
    const order = await h.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 1 }],
      },
      ACTOR,
    );
    await expect(
      h.service.postGoodsReceipt(
        TENANT,
        order.id,
        {
          lines: [
            {
              purchaseOrderLineId: order.lines[0].id,
              quantityReceived: 1,
            },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows.movements).toHaveLength(0);
  });

  it('refuses a receipt line that belongs to another order', async () => {
    const first = await submittedOrder(h);
    const second = await submittedOrder(h, [
      { productId: 'prod-b', quantityOrdered: 2 },
    ]);
    await expect(
      h.service.postGoodsReceipt(
        TENANT,
        first.orderId,
        {
          lines: [
            { purchaseOrderLineId: second.lineIds[0], quantityReceived: 1 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.rows.movements).toHaveLength(0);
  });

  it('refuses to receive against an order in another tenant', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await expect(
      h.service.postGoodsReceipt(
        OTHER_TENANT,
        orderId,
        { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 1 }] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.rows.movements).toHaveLength(0);
  });
});

describe('receiving is idempotent', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('returns the original receipt on a replay instead of stocking twice', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    const payload = {
      idempotencyKey: 'delivery-note-88',
      lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 5 }],
    };
    const first = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      payload,
      ACTOR,
    );
    const replay = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      payload,
      ACTOR,
    );
    expect(replay.id).toBe(first.id);
    expect(h.rows.goodsReceipts).toHaveLength(1);
    expect(h.rows.movements).toHaveLength(1);
    expect(h.levels.get('store-1:prod-a')).toBe(60);
    expect(Object.fromEntries(h.replayLedger())).toEqual(
      Object.fromEntries(h.levels),
    );
  });

  it('rejects the same key reused against a different order', async () => {
    const first = await submittedOrder(h);
    const second = await submittedOrder(h, [
      { productId: 'prod-b', quantityOrdered: 3 },
    ]);
    await h.service.postGoodsReceipt(
      TENANT,
      first.orderId,
      {
        idempotencyKey: 'shared-key',
        lines: [
          { purchaseOrderLineId: first.lineIds[0], quantityReceived: 1 },
        ],
      },
      ACTOR,
    );
    await expect(
      h.service.postGoodsReceipt(
        TENANT,
        second.orderId,
        {
          idempotencyKey: 'shared-key',
          lines: [
            { purchaseOrderLineId: second.lineIds[0], quantityReceived: 1 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows.movements).toHaveLength(1);
  });

  it('treats two deliveries without a key as two deliveries', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 2 }] },
      ACTOR,
    );
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 2 }] },
      ACTOR,
    );
    expect(h.rows.goodsReceipts).toHaveLength(2);
    expect(h.levels.get('store-1:prod-a')).toBe(48);
  });
});

describe('audit trail', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('records the receipt and the status change it caused', async () => {
    const { orderId, lineIds } = await submittedOrder(h);
    await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 10 }] },
      ACTOR,
    );
    const actions = h.rows.audits.map((entry) => entry.action);
    expect(actions).toContain('RECEIVE');
    expect(
      h.rows.audits.some(
        (entry) =>
          entry.entityType === 'PurchaseOrder' &&
          String(entry.reason).includes('RECEIVED'),
      ),
    ).toBe(true);
  });

  it('attributes every entry to the acting user and tenant', async () => {
    await h.service.createSupplier(TENANT, { code: 'ACME', name: 'A' }, ACTOR);
    const entry = h.rows.audits.at(-1)!;
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.actorId).toBe(ACTOR.id);
    expect(entry.actorEmail).toBe(ACTOR.email);
  });
});

/**
 * The 10,000th document of a year.
 *
 * References are allocated by taking the highest one already issued for the
 * tenant-year and adding one. While every sequence was four digits wide, a
 * STRING sort and a numeric sort agreed, so ordering by the reference column
 * looked right. It stops being right the moment `PO-2026-10000` exists:
 * lexicographically `'PO-2026-9999' > 'PO-2026-10000'`, so the lookup keeps
 * returning 9999, the allocator keeps proposing 10000, the (tenantId,
 * reference) unique keeps rejecting it, and every purchase order and goods
 * receipt for that tenant-year fails permanently until January.
 *
 * These tests seed populations that CROSS that boundary — which is exactly
 * what the rest of the suite never does, and why it passed over the bug.
 */
describe('reference numbering past four digits', () => {
  let h: Harness;

  beforeEach(() => {
    // Pin the clock: references are keyed by the calendar year, so a suite
    // that seeds "this year" has to say which year that is.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    h = buildHarness();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A purchase order created the ordinary way, returning its reference. */
  async function createOrder(harness: Harness): Promise<string> {
    const supplier = await harness.service.createSupplier(
      TENANT,
      { code: `acme-${harness.rows.suppliers.length}`, name: 'Acme' },
      ACTOR,
    );
    const order = await harness.service.createPurchaseOrder(
      TENANT,
      {
        supplierId: supplier.id,
        locationId: 'store-1',
        currencyCode: 'AED',
        lines: [{ productId: 'prod-a', quantityOrdered: 1, unitCostMinor: 1 }],
      },
      ACTOR,
    );
    return order.reference;
  }

  it('allocates 10000 after 9999, and 10001 after that', async () => {
    h.seedReference('purchaseOrder', 'PO-2026-9998');
    h.seedReference('purchaseOrder', 'PO-2026-9999');

    await expect(createOrder(h)).resolves.toBe('PO-2026-10000');
    await expect(createOrder(h)).resolves.toBe('PO-2026-10001');
  });

  it('allocates 100000 after 99999 — the fix is not a wider constant', async () => {
    // Widening the padding to six digits would have made the previous test
    // pass and moved the cliff here instead. Ordering on an integer has no
    // cliff at any width.
    h.seedReference('purchaseOrder', 'PO-2026-99999');

    await expect(createOrder(h)).resolves.toBe('PO-2026-100000');
    await expect(createOrder(h)).resolves.toBe('PO-2026-100001');
  });

  it('finds the true maximum in a population of mixed widths', async () => {
    // Sorted as strings this year reads
    //   PO-2026-9999 > PO-2026-20000 > PO-2026-10000 > PO-2026-0007,
    // because '9' > '2' > '1' > '0' at the first digit and length never
    // enters into it. A string-ordered lookup answers 9999 and proposes a
    // number issued ten thousand documents ago.
    for (const reference of [
      'PO-2026-0007',
      'PO-2026-9999',
      'PO-2026-10000',
      'PO-2026-20000',
    ]) {
      h.seedReference('purchaseOrder', reference);
    }

    await expect(createOrder(h)).resolves.toBe('PO-2026-20001');
  });

  it('numbers goods receipts past the boundary as well', async () => {
    // Both sides of the boundary, so the string order really disagrees:
    // 'GR-2026-9999' sorts above 'GR-2026-10000'.
    h.seedReference('goodsReceipt', 'GR-2026-9999');
    h.seedReference('goodsReceipt', 'GR-2026-10000');
    const { orderId, lineIds } = await submittedOrder(h);

    const receipt = await h.service.postGoodsReceipt(
      TENANT,
      orderId,
      { lines: [{ purchaseOrderLineId: lineIds[0], quantityReceived: 10 }] },
      ACTOR,
    );

    expect(receipt.reference).toBe('GR-2026-10001');
  });

  it('restarts at 0001 in the new year, however high the old year reached', async () => {
    h.seedReference('purchaseOrder', 'PO-2026-100000');
    jest.setSystemTime(new Date('2027-01-02T09:00:00Z'));

    await expect(createOrder(h)).resolves.toBe('PO-2027-0001');
    await expect(createOrder(h)).resolves.toBe('PO-2027-0002');
  });

  it('leaves another tenant of the same year untouched', async () => {
    h.seedReference('purchaseOrder', 'PO-2026-10000', OTHER_TENANT);

    await expect(createOrder(h)).resolves.toBe('PO-2026-0001');
  });

  it('gives two simultaneous creations distinct references', async () => {
    // Both transactions read the same maximum before either inserts, so the
    // loser meets the (tenantId, reference) unique. It must come back with a
    // DIFFERENT number rather than retrying into the same one forever —
    // termination is the whole point, and it holds because every attempt
    // re-reads a maximum that now includes the winner's row.
    h.seedReference('purchaseOrder', 'PO-2026-9999');

    const references = await Promise.all([createOrder(h), createOrder(h)]);

    expect(new Set(references).size).toBe(2);
    expect([...references].sort()).toEqual(['PO-2026-10000', 'PO-2026-10001']);
    // Three inserts for two orders: the collision really happened and was
    // resolved by one replay, not avoided by the fake serializing the work.
    expect(h.prisma.purchaseOrder.create).toHaveBeenCalledTimes(3);
    expect(
      h.rows.purchaseOrders.map((order) => order.reference as string).sort(),
    ).toEqual(['PO-2026-10000', 'PO-2026-10001', 'PO-2026-9999']);
  });

  it('stores the year and sequence the ordering depends on', async () => {
    await createOrder(h);
    const order = h.rows.purchaseOrders.at(-1)!;

    expect(order.reference).toBe('PO-2026-0001');
    expect(order.referenceYear).toBe(2026);
    expect(order.referenceSequence).toBe(1);
  });
});
