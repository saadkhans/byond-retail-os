/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';
import { AuditLogService } from '../src/common/audit/audit-log.service';
import {
  AdjustmentRejected,
  InventoryRepository,
} from '../src/inventory/inventory.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProcurementRepository } from '../src/procurement/procurement.repository';
import {
  GOODS_RECEIPT_REFERENCE_PREFIX,
  PURCHASE_ORDER_REFERENCE_PREFIX,
} from '../src/procurement/procurement.constants';
import { referenceSequenceOf } from '../src/procurement/procurement.logic';
import { ProcurementService } from '../src/procurement/procurement.service';
import { SimulatedSupplierAdapter } from '../src/procurement/adapters/simulated-supplier.adapter';
import { SupplierIntegrationPort } from '../src/procurement/supplier-integration.port';

/**
 * In-memory stand-in for the procurement tables plus a faithful-enough
 * inventory ledger.
 *
 * The ledger fake matters more than the rest: it appends a movement and moves
 * the projection in one step, exactly as `InventoryRepository.applyMovement`
 * does, and the harness exposes both so a test can prove the projection always
 * equals a replay of the ledger. `inventoryLevel` is deliberately booby-trapped
 * — any attempt to write it directly fails the test, which is how the "stock
 * only ever moves through the ledger" invariant is enforced statically rather
 * than hopefully.
 */

export const TENANT = 'tenant-1';
export const OTHER_TENANT = 'tenant-2';
export const ACTOR = { id: 'user-1', email: 'ops@example.com' };

type Row = Record<string, any>;

export interface Harness {
  service: ProcurementService;
  repository: ProcurementRepository;
  rows: {
    suppliers: Row[];
    supplierProducts: Row[];
    supplierProductCosts: Row[];
    purchaseOrders: Row[];
    purchaseOrderLines: Row[];
    goodsReceipts: Row[];
    goodsReceiptLines: Row[];
    movements: Row[];
    audits: Row[];
  };
  /** Projected stock, keyed `${locationId}:${productId}`. */
  levels: Map<string, number>;
  /** Replays the ledger from scratch — must always equal `levels`. */
  replayLedger(): Map<string, number>;
  supplierAdapter: { submitOrder: jest.Mock };
  /** The fake client, so a test can assert on the predicate a write used. */
  prisma: any;
  seedProduct(id: string, tenantId?: string): void;
  /**
   * Drops a purchase order or goods receipt straight into the table, the way a
   * tenant that has been ordering all year already has thousands. The year and
   * sequence are derived from the reference with the SAME parser the backfill
   * migration uses, so a seeded population is shaped like a migrated one.
   */
  seedReference(
    model: 'purchaseOrder' | 'goodsReceipt',
    reference: string,
    tenantId?: string,
  ): void;
}

/**
 * The (tenantId, reference) unique index, enforced in the fake.
 *
 * Without it the fake would happily store two orders sharing a reference and
 * the bug this harness exists to catch — a lookup that keeps proposing a
 * number the database has already taken — would look like success. Throwing
 * the real Prisma error means the repository's conflict handling is exercised
 * exactly as it is in production.
 */
function assertReferenceFree(rows: Row[], data: Row): void {
  if (
    data.reference !== undefined &&
    rows.some(
      (row) =>
        row.tenantId === data.tenantId && row.reference === data.reference,
    )
  ) {
    throw new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on the fields: (\`tenantId\`,\`reference\`)`,
      {
        code: 'P2002',
        clientVersion: 'harness',
        meta: { target: ['tenantId', 'reference'] },
      },
    );
  }
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) {
        return (c.in as unknown[]).includes(row[key]);
      }
      if ('not' in c) {
        return row[key] !== c.not;
      }
      if ('startsWith' in c) {
        return String(row[key] ?? '').startsWith(String(c.startsWith));
      }
    }
    return row[key] === cond;
  });
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const sorted = [...rows];
  for (const clause of [...clauses].reverse()) {
    const [field, direction] = Object.entries(clause)[0] as [string, string];
    sorted.sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      const cmp =
        av instanceof Date && bv instanceof Date
          ? av.getTime() - bv.getTime()
          : av < bv
            ? -1
            : av > bv
              ? 1
              : 0;
      return direction === 'desc' ? -cmp : cmp;
    });
  }
  return sorted;
}

export function buildHarness(): Harness {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

  const suppliers: Row[] = [];
  const supplierProducts: Row[] = [];
  const supplierProductCosts: Row[] = [];
  const purchaseOrders: Row[] = [];
  const purchaseOrderLines: Row[] = [];
  const goodsReceipts: Row[] = [];
  const goodsReceiptLines: Row[] = [];
  const movements: Row[] = [];
  const audits: Row[] = [];
  const levels = new Map<string, number>();

  const locations: Row[] = [
    { id: 'store-1', tenantId: TENANT, code: 'STORE-01', name: 'Downtown' },
    { id: 'store-9', tenantId: OTHER_TENANT, code: 'STORE-09', name: 'Other' },
  ];
  const products: Row[] = [
    { id: 'prod-a', tenantId: TENANT, sku: 'SKU-A', name: 'Product A' },
    { id: 'prod-b', tenantId: TENANT, sku: 'SKU-B', name: 'Product B' },
    {
      id: 'prod-foreign',
      tenantId: OTHER_TENANT,
      sku: 'SKU-F',
      name: 'Foreign',
    },
  ];

  const table = (rows: Row[], prefix: string, defaults: Row = {}) => ({
    findFirst: jest.fn(async (args: Row = {}) => {
      const hit = sortRows(
        rows.filter((row) => matches(row, args.where ?? {})),
        args.orderBy,
      )[0];
      return hit ? { ...hit } : null;
    }),
    findFirstOrThrow: jest.fn(async (args: Row = {}) => {
      const hit = rows.find((row) => matches(row, args.where ?? {}));
      if (!hit) {
        throw new Error(`no ${prefix} matching ${JSON.stringify(args.where)}`);
      }
      return { ...hit };
    }),
    findMany: jest.fn(async (args: Row = {}) =>
      sortRows(
        rows.filter((row) => matches(row, args.where ?? {})),
        args.orderBy,
      )
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length))
        .map((row) => ({ ...row })),
    ),
    count: jest.fn(
      async (args: Row = {}) =>
        rows.filter((row) => matches(row, args.where ?? {})).length,
    ),
    create: jest.fn(async (args: Row) => {
      const row: Row = { id: nextId(prefix), ...defaults, ...args.data };
      rows.push(row);
      return { ...row };
    }),
    // Mutating writes must carry the tenant IN the predicate (the
    // `id_tenantId` composite key), never rely only on a prior tenant-scoped
    // lookup — the rule LocationsRepository was corrected to follow. A plain
    // `{ id }` predicate fails the test by construction, the same way writing
    // `inventoryLevel` directly does.
    update: jest.fn(async (args: Row) => {
      const key = args.where?.id_tenantId as
        | { id: string; tenantId: string }
        | undefined;
      if (!key) {
        throw new Error(
          `procurement updated ${prefix} without the id_tenantId composite ` +
            'key — a tenant-scoped write must name the tenant in its predicate',
        );
      }
      const row = rows.find(
        (candidate) =>
          candidate.id === key.id && candidate.tenantId === key.tenantId,
      );
      if (!row) {
        throw new Error(`no ${prefix} ${String(key.id)}`);
      }
      for (const [key, value] of Object.entries(args.data as Row)) {
        if (value !== undefined) {
          row[key] = value;
        }
      }
      return { ...row };
    }),
  });

  /** `table`, plus the (tenantId, reference) unique on create. */
  const tableWithUniqueReference = (
    rows: Row[],
    prefix: string,
    defaults: Row = {},
  ) => {
    const base = table(rows, prefix, defaults);
    const rawCreate = base.create;
    return {
      ...base,
      create: jest.fn(async (args: Row) => {
        assertReferenceFree(rows, args.data as Row);
        return rawCreate(args);
      }),
    };
  };

  const now = new Date('2026-09-16T12:00:00Z');

  const prisma: any = {
    location: {
      findFirst: jest.fn(async (args: Row) => {
        const hit = locations.find((row) => matches(row, args.where));
        return hit ? { ...hit } : null;
      }),
    },
    product: {
      findFirst: jest.fn(async (args: Row) => {
        const hit = products.find((row) => matches(row, args.where));
        return hit ? { ...hit } : null;
      }),
      findMany: jest.fn(async (args: Row) =>
        products.filter((row) => matches(row, args.where)).map((r) => ({ ...r })),
      ),
    },
    supplier: table(suppliers, 'supplier', {
      status: 'ACTIVE',
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      leadTimeDays: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    }),
    supplierProduct: table(supplierProducts, 'sp', {
      isPreferred: false,
      leadTimeDays: null,
      createdAt: now,
      updatedAt: now,
    }),
    supplierProductCost: table(supplierProductCosts, 'spc', {
      reason: null,
      recordedAt: now,
    }),
    purchaseOrderLine: table(purchaseOrderLines, 'pol', {
      supplierProductId: null,
      packSize: 1,
      createdAt: now,
      updatedAt: now,
    }),
    goodsReceiptLine: table(goodsReceiptLines, 'grl', {
      discrepancy: 'NONE',
      discrepancyNote: null,
      inventoryMovementId: null,
      packSize: 1,
      createdAt: now,
    }),
    inventoryMovement: {
      findMany: jest.fn(async (args: Row = {}) =>
        movements
          .filter((row) => matches(row, args.where ?? {}))
          .map((row) => ({ ...row })),
      ),
    },
    // Writing a stock level outside the ledger is the one thing this domain
    // must never do. Any call here fails the test by construction.
    inventoryLevel: new Proxy(
      {},
      {
        get(_target, property) {
          return () => {
            throw new Error(
              `procurement wrote inventoryLevel.${String(property)} directly — ` +
                'stock must only ever move through the ledger',
            );
          };
        },
      },
    ),
    auditLog: {
      create: jest.fn(async (args: Row) => {
        audits.push(args.data);
        return args.data;
      }),
    },
    $queryRaw: jest.fn(async () => []),
  };

  // Purchase orders are created with nested lines and read back with an
  // include, so those two shapes need real handling rather than the generic
  // table helper.
  const hydrateOrder = (order: Row): Row => ({
    ...order,
    supplier: suppliers.find((s) => s.id === order.supplierId) ?? null,
    location: locations.find((l) => l.id === order.locationId) ?? null,
    lines: purchaseOrderLines
      .filter((line) => line.purchaseOrderId === order.id)
      .map((line) => ({
        ...line,
        product: products.find((p) => p.id === line.productId) ?? null,
        supplierProduct:
          supplierProducts.find((sp) => sp.id === line.supplierProductId) ??
          null,
      })),
    receipts: goodsReceipts
      .filter((receipt) => receipt.purchaseOrderId === order.id)
      .map((receipt) => hydrateReceipt(receipt)),
  });

  const hydrateReceipt = (receipt: Row): Row => ({
    ...receipt,
    lines: goodsReceiptLines
      .filter((line) => line.goodsReceiptId === receipt.id)
      .map((line) => ({
        ...line,
        product: products.find((p) => p.id === line.productId) ?? null,
      })),
  });

  prisma.purchaseOrder = {
    ...table(purchaseOrders, 'po', {
      status: 'DRAFT',
      expectedAt: null,
      submittedAt: null,
      closedAt: null,
      cancelledReason: null,
      totalCostMinor: null,
      notes: null,
      externalReference: null,
      submittedById: null,
      createdAt: now,
      updatedAt: now,
    }),
  };
  const rawOrderCreate = prisma.purchaseOrder.create;
  prisma.purchaseOrder.create = jest.fn(async (args: Row) => {
    const { lines, ...data } = args.data as Row;
    assertReferenceFree(purchaseOrders, data);
    const order = await rawOrderCreate({ data });
    if (lines?.create) {
      for (const line of lines.create as Row[]) {
        purchaseOrderLines.push({
          id: nextId('pol'),
          purchaseOrderId: order.id,
          supplierProductId: null,
          packSize: 1,
          createdAt: now,
          updatedAt: now,
          ...line,
        });
      }
    }
    return args.include ? hydrateOrder(order) : order;
  });
  const rawOrderFindFirst = prisma.purchaseOrder.findFirst;
  prisma.purchaseOrder.findFirst = jest.fn(async (args: Row) => {
    const order = await rawOrderFindFirst(args);
    if (!order) {
      return null;
    }
    if (args.include?.lines && !args.include.receipts) {
      return {
        ...order,
        lines: purchaseOrderLines
          .filter((line) => line.purchaseOrderId === order.id)
          .map((line) => ({ ...line })),
      };
    }
    return args.include ? hydrateOrder(order) : order;
  });
  const rawOrderFindMany = prisma.purchaseOrder.findMany;
  prisma.purchaseOrder.findMany = jest.fn(async (args: Row) => {
    const rows = await rawOrderFindMany(args);
    return args.include ? rows.map((row: Row) => hydrateOrder(row)) : rows;
  });
  const rawOrderUpdate = prisma.purchaseOrder.update;
  prisma.purchaseOrder.update = jest.fn(async (args: Row) => {
    const order = await rawOrderUpdate(args);
    return args.include ? hydrateOrder(order) : order;
  });

  prisma.goodsReceipt = {
    ...tableWithUniqueReference(goodsReceipts, 'gr', {
      deliveryNote: null,
      notes: null,
      idempotencyKey: null,
      receivedById: null,
      receivedAt: now,
      createdAt: now,
    }),
  };
  for (const method of ['findFirst', 'findFirstOrThrow', 'findMany'] as const) {
    const raw = prisma.goodsReceipt[method];
    prisma.goodsReceipt[method] = jest.fn(async (args: Row) => {
      const result = await raw(args);
      if (!args?.include) {
        return result;
      }
      return Array.isArray(result)
        ? result.map((row: Row) => hydrateReceipt(row))
        : result
          ? hydrateReceipt(result)
          : result;
    });
  }

  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );

  const auditLog = {
    record: jest.fn(async (entry: Row) => {
      audits.push(entry);
    }),
  } as unknown as AuditLogService;

  /**
   * Stands in for the real `applyMovement`: same rejections, same atomic
   * "append the movement and move the projection" behaviour.
   */
  const inventoryRepository = {
    applyMovement: jest.fn(async (_tx: unknown, input: Row) => {
      const product = products.find(
        (row) => row.id === input.productId && row.tenantId === input.tenantId,
      );
      if (!product) {
        throw new AdjustmentRejected('product-not-found');
      }
      const location = locations.find(
        (row) => row.id === input.locationId && row.tenantId === input.tenantId,
      );
      if (!location) {
        throw new AdjustmentRejected('location-not-found');
      }
      const key = `${String(input.locationId)}:${String(input.productId)}`;
      const next = (levels.get(key) ?? 0) + (input.quantityDelta as number);
      if (next < 0) {
        throw new AdjustmentRejected('insufficient-stock');
      }
      levels.set(key, next);
      const movement: Row = {
        id: nextId('mov'),
        tenantId: input.tenantId,
        locationId: input.locationId,
        productId: input.productId,
        movementType: input.movementType,
        quantityDelta: input.quantityDelta,
        quantityAfter: next,
        reason: input.reason ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        createdById: input.createdById ?? null,
        createdAt: new Date(now.getTime() + movements.length),
      };
      movements.push(movement);
      return { movement, level: { quantity: next } };
    }),
  } as unknown as InventoryRepository;

  const supplierAdapter = {
    submitOrder: jest.fn(async (request: Row) =>
      new SimulatedSupplierAdapter().submitOrder(request as never),
    ),
  };

  const repository = new ProcurementRepository(
    prisma as unknown as PrismaService,
    auditLog,
    inventoryRepository,
  );
  const service = new ProcurementService(
    repository,
    supplierAdapter as unknown as SupplierIntegrationPort,
  );

  return {
    service,
    repository,
    rows: {
      suppliers,
      supplierProducts,
      supplierProductCosts,
      purchaseOrders,
      purchaseOrderLines,
      goodsReceipts,
      goodsReceiptLines,
      movements,
      audits,
    },
    levels,
    replayLedger() {
      const replayed = new Map<string, number>();
      for (const movement of movements) {
        const key = `${String(movement.locationId)}:${String(movement.productId)}`;
        replayed.set(
          key,
          (replayed.get(key) ?? 0) + (movement.quantityDelta as number),
        );
      }
      return replayed;
    },
    supplierAdapter,
    prisma,
    seedProduct(id: string, tenantId: string = TENANT) {
      products.push({ id, tenantId, sku: id.toUpperCase(), name: id });
    },
    seedReference(
      model: 'purchaseOrder' | 'goodsReceipt',
      reference: string,
      tenantId: string = TENANT,
    ) {
      const prefix =
        model === 'purchaseOrder'
          ? PURCHASE_ORDER_REFERENCE_PREFIX
          : GOODS_RECEIPT_REFERENCE_PREFIX;
      const year = Number.parseInt(reference.split('-')[1] ?? '0', 10);
      const sequence = referenceSequenceOf(prefix, year, reference);
      const row: Row = {
        id: nextId(model === 'purchaseOrder' ? 'po' : 'gr'),
        tenantId,
        reference,
        referenceYear: Number.isNaN(year) ? now.getUTCFullYear() : year,
        referenceSequence: sequence ?? 0,
        createdAt: now,
      };
      if (model === 'purchaseOrder') {
        purchaseOrders.push({
          ...row,
          supplierId: 'seeded',
          locationId: 'store-1',
          status: 'RECEIVED',
          currencyCode: 'AED',
          updatedAt: now,
        });
      } else {
        goodsReceipts.push({
          ...row,
          purchaseOrderId: 'seeded',
          receivedAt: now,
        });
      }
    },
  };
}
