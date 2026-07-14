import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Deterministic in-memory fixture — no database (same pattern as
// catalog-inventory.e2e-spec). Cost 4 keeps the suite fast.
const PASSWORDS = {
  admin: 'admin-local-password',
  manager: 'manager-local-password',
  viewer: 'viewer-local-password',
};

interface Row {
  [key: string]: unknown;
  id: string;
  tenantId: string;
}

describe('Checkout sessions & orders (e2e, no live database)', () => {
  let app: INestApplication;
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;
  // Ids are '<prefix>-<n>'; the numeric suffix is the deterministic
  // insertion-order tie-breaker the stub sorts by (mirroring the API's
  // "id as tie-breaker" ordering contract).
  const idSeq = (id: unknown) => Number(String(id).split('-').pop());

  const users = [
    {
      id: 'admin-1',
      tenantId: null as string | null,
      userType: 'PLATFORM',
      email: 'admin@byond.local',
      firstName: 'Platform',
      lastName: 'Admin',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.admin, 4),
      lastLoginAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    },
    {
      id: 'manager-a',
      tenantId: 'tenant-a',
      userType: 'TENANT',
      email: 'manager@tenant-a.example',
      firstName: 'Mana',
      lastName: 'Ger',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.manager, 4),
      lastLoginAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    },
    {
      id: 'viewer-a',
      tenantId: 'tenant-a',
      userType: 'TENANT',
      email: 'viewer@tenant-a.example',
      firstName: 'View',
      lastName: 'Er',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.viewer, 4),
      lastLoginAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    },
  ];

  // viewer-a deliberately holds ONLY checkout:read — it exercises both the
  // "no checkout:manage" and the "no order:read" denial paths.
  const grants: Record<string, { tenantId: string | null; codes: string[] }> =
    {
      'admin-1': { tenantId: null, codes: ['tenant:read', 'module:read'] },
      'manager-a': {
        tenantId: 'tenant-a',
        codes: [
          'checkout:read',
          'checkout:manage',
          'order:read',
          'order:manage',
        ],
      },
      'viewer-a': { tenantId: 'tenant-a', codes: ['checkout:read'] },
    };

  const locations = [
    { id: 'loc-a1', tenantId: 'tenant-a', name: 'Store A1', code: 'A1' },
    { id: 'loc-a2', tenantId: 'tenant-a', name: 'Store A2', code: 'A2' },
    { id: 'loc-b1', tenantId: 'tenant-b', name: 'Store B1', code: 'B1' },
  ];

  const units = [
    {
      id: 'unit-a1',
      tenantId: 'tenant-a',
      locationId: 'loc-a1',
      name: 'Fridge A1-1',
      code: 'U-A1',
      status: 'ACTIVE',
    },
    {
      id: 'unit-a2',
      tenantId: 'tenant-a',
      locationId: 'loc-a2',
      name: 'Fridge A2-1',
      code: 'U-A2',
      status: 'ACTIVE',
    },
    {
      id: 'unit-b1',
      tenantId: 'tenant-b',
      locationId: 'loc-b1',
      name: 'Fridge B1-1',
      code: 'U-B1',
      status: 'ACTIVE',
    },
  ];

  const devices = [
    { id: 'dev-a1', tenantId: 'tenant-a', unitId: 'unit-a1' },
    { id: 'dev-b1', tenantId: 'tenant-b', unitId: 'unit-b1' },
  ];

  const products = [
    {
      id: 'prod-a1',
      tenantId: 'tenant-a',
      sku: 'A-COLA-330',
      name: 'Cola 330ml',
      unitOfMeasure: 'EACH',
      status: 'ACTIVE',
      lowStockThreshold: null,
    },
    {
      id: 'prod-a2',
      tenantId: 'tenant-a',
      sku: 'A-CHIPS-50',
      name: 'Chips 50g',
      unitOfMeasure: 'PACK',
      status: 'ACTIVE',
      lowStockThreshold: null,
    },
    {
      id: 'prod-draft',
      tenantId: 'tenant-a',
      sku: 'A-DRAFT-1',
      name: 'Unreleased Item',
      unitOfMeasure: 'EACH',
      status: 'DRAFT',
      lowStockThreshold: null,
    },
    {
      id: 'prod-b',
      tenantId: 'tenant-b',
      sku: 'B-SKU-1',
      name: 'Tenant B Cola',
      unitOfMeasure: 'EACH',
      status: 'ACTIVE',
      lowStockThreshold: null,
    },
  ];

  // Module catalog + per-tenant enablement backing the ModuleEnabledGuard.
  const platformModules = [
    { id: 'module-core', code: 'core', name: 'Core', isActive: true },
    {
      id: 'module-checkout',
      code: 'checkout',
      name: 'Checkout & Orders',
      isActive: true,
    },
  ];
  const tenantModules = [
    {
      id: 'tm-a-checkout',
      tenantId: 'tenant-a',
      moduleId: 'module-checkout',
      status: 'ENABLED',
    },
  ];

  // Stateful in-memory tables. Tenant B rows exist purely as cross-tenant
  // "bait" — every test asserts they stay invisible to tenant A callers.
  const store = {
    sessions: [
      {
        id: 'sess-b',
        tenantId: 'tenant-b',
        locationId: 'loc-b1',
        unitId: 'unit-b1',
        deviceId: null,
        status: 'OPEN',
        startedAt: new Date('2026-07-12T00:00:00Z'),
        endedAt: null,
        sourceType: 'MANUAL',
        sourceId: null,
        evidenceBundleId: null,
        visionEventId: null,
        vlmReviewId: null,
        evidenceScore: null,
        evidenceQuality: null,
        reasonCodes: [],
        idempotencyKey: null,
        createdById: null,
      },
    ] as Row[],
    sessionLines: [] as Row[],
    orders: [
      {
        id: 'order-b',
        tenantId: 'tenant-b',
        orderNumber: 'ORD-000001',
        checkoutSessionId: 'sess-b',
        locationId: 'loc-b1',
        unitId: 'unit-b1',
        status: 'CONFIRMED',
        placedAt: new Date('2026-07-12T00:00:00Z'),
        confirmedAt: new Date('2026-07-12T00:00:00Z'),
        cancelledAt: null,
        cancelReason: null,
        totalQuantity: 1,
        subtotalMinor: null,
        totalMinor: null,
        currencyCode: null,
        sourceType: 'MANUAL',
        sourceId: null,
        evidenceBundleId: null,
        visionEventId: null,
        vlmReviewId: null,
        evidenceScore: null,
        evidenceQuality: null,
        reasonCodes: [],
        idempotencyKey: null,
        createdById: null,
      },
    ] as Row[],
    orderLines: [] as Row[],
    levels: [
      {
        id: 'level-a1-cola',
        tenantId: 'tenant-a',
        locationId: 'loc-a1',
        productId: 'prod-a1',
        quantity: 100,
      },
      {
        id: 'level-a1-chips',
        tenantId: 'tenant-a',
        locationId: 'loc-a1',
        productId: 'prod-a2',
        quantity: 2,
      },
    ] as (Row & { quantity: number })[],
    movements: [] as Row[],
  };

  const auditCreateSpy = jest.fn().mockResolvedValue({});

  // The stub interprets loosely-typed Prisma `where`/`data` shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Where = Record<string, any>;

  function matchScalar(row: Row, where: Where, keys: string[]): boolean {
    return keys.every(
      (key) => where[key] === undefined || row[key] === where[key],
    );
  }

  // Prisma applies column defaults when a create field is undefined; a naive
  // spread would clobber the stub's defaults with undefined instead.
  function stripUndefined(data: Where): Where & { tenantId: string } {
    return Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    ) as Where & { tenantId: string };
  }

  const refPick = (rows: { id: string }[], id: unknown) => {
    const row = rows.find((candidate) => candidate.id === id) as
      | (Row & { name?: unknown; code?: unknown })
      | undefined;
    return row ? { id: row.id, name: row.name, code: row.code } : null;
  };

  const byCreatedAsc = (a: Row, b: Row) => idSeq(a.id) - idSeq(b.id);

  /** Applies the session read shapes (SESSION_INCLUDE / DETAIL / lines). */
  function sessionView(row: Row, include?: Where): Row {
    const view: Row = { ...row };
    if (!include) {
      return view;
    }
    if (include.location) {
      view.location = refPick(locations, row.locationId);
    }
    if (include.unit) {
      view.unit = refPick(units, row.unitId);
    }
    if (include.lines) {
      view.lines = store.sessionLines
        .filter((line) => line.sessionId === row.id)
        .sort(byCreatedAsc);
    }
    if (include.order) {
      const order = store.orders.find(
        (candidate) => candidate.checkoutSessionId === row.id,
      );
      view.order = order
        ? {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
          }
        : null;
    }
    return view;
  }

  /** Applies the order read shapes (ORDER_INCLUDE / DETAIL / COMPLETION). */
  function orderView(row: Row, include?: Where): Row {
    const view: Row = { ...row };
    if (!include) {
      return view;
    }
    if (include.location) {
      view.location = refPick(locations, row.locationId);
    }
    if (include.unit) {
      view.unit = refPick(units, row.unitId);
    }
    if (include.lines) {
      view.lines = store.orderLines
        .filter((line) => line.orderId === row.id)
        .sort(byCreatedAsc);
    }
    if (include.session) {
      const session = store.sessions.find(
        (candidate) => candidate.id === row.checkoutSessionId,
      );
      view.session = session
        ? {
            id: session.id,
            status: session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
          }
        : null;
    }
    return view;
  }

  function matchesSession(row: Row, where: Where): boolean {
    return matchScalar(row, where, [
      'id',
      'tenantId',
      'status',
      'locationId',
      'unitId',
      'idempotencyKey',
    ]);
  }

  function matchesOrder(row: Row, where: Where): boolean {
    if (
      !matchScalar(row, where, [
        'id',
        'tenantId',
        'locationId',
        'unitId',
        'checkoutSessionId',
        'idempotencyKey',
      ])
    ) {
      return false;
    }
    // status is a plain string except in cancel()'s conditional updateMany,
    // which the order.updateMany stub handles itself.
    if (typeof where.status === 'string' && row.status !== where.status) {
      return false;
    }
    if (where.orderNumber !== undefined) {
      const wanted =
        typeof where.orderNumber === 'string'
          ? where.orderNumber
          : String(where.orderNumber.equals);
      const insensitive =
        typeof where.orderNumber === 'object' &&
        where.orderNumber.mode === 'insensitive';
      const actual = String(row.orderNumber);
      if (
        insensitive
          ? actual.toLowerCase() !== wanted.toLowerCase()
          : actual !== wanted
      ) {
        return false;
      }
    }
    return true;
  }

  const mutableTables = [
    'sessions',
    'sessionLines',
    'orders',
    'orderLines',
    'levels',
    'movements',
  ] as const;

  const prismaStub = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Tenant"')
        ? Promise.resolve([{ status: 'ACTIVE' }])
        : Promise.resolve([1]),
    ),
    // Emulates transactional rollback: repositories rely on a thrown
    // AdjustmentRejected (via CompletionStockRejected) undoing every write
    // of the completion — order, order lines, movements, level decrements,
    // and the session flip. The real database gives this for free; the stub
    // snapshots and restores its tables so the atomicity tests are honest.
    $transaction: async (callback: (tx: unknown) => unknown) => {
      const snapshot = structuredClone(
        Object.fromEntries(
          mutableTables.map((table) => [table, store[table]]),
        ),
      ) as Record<(typeof mutableTables)[number], Row[]>;
      try {
        return await callback(prismaStub);
      } catch (error) {
        for (const table of mutableTables) {
          (store[table] as Row[]).length = 0;
          (store[table] as Row[]).push(...snapshot[table]);
        }
        throw error;
      }
    },
    user: {
      findUnique: async ({ where }: { where: Where }) =>
        users.find(
          (candidate) =>
            (where.email && candidate.email === where.email) ||
            (where.id && candidate.id === where.id),
        ) ?? null,
      findFirst: async ({ where }: { where: Where }) => {
        const found = users.find(
          (candidate) =>
            (where.id === undefined || candidate.id === where.id) &&
            (where.email === undefined || candidate.email === where.email) &&
            (where.tenantId === undefined ||
              candidate.tenantId === where.tenantId) &&
            (where.status === undefined || candidate.status === where.status),
        );
        return found
          ? { ...found, tenant: found.tenantId ? { status: 'ACTIVE' } : null }
          : null;
      },
      updateMany: async ({ where }: { where: Where }) => ({
        count: users.some((candidate) => candidate.id === where.id) ? 1 : 0,
      }),
      update: async ({ where }: { where: Where }) =>
        users.find((candidate) => candidate.id === where.id),
    },
    userRole: {
      findMany: async ({ where }: { where: Where }) => {
        const grant = grants[String(where.userId)];
        if (!grant || grant.tenantId !== (where.tenantId ?? null)) {
          return [];
        }
        return [
          {
            role: {
              rolePermissions: grant.codes.map((code) => ({
                permission: { code },
              })),
            },
          },
        ];
      },
    },
    auditLog: { create: auditCreateSpy },
    platformModule: {
      findUnique: async ({ where }: { where: Where }) =>
        platformModules.find((module) => module.code === where.code) ?? null,
    },
    tenantModule: {
      findFirst: async ({ where }: { where: Where }) =>
        tenantModules.find(
          (tenantModule) =>
            tenantModule.tenantId === where.tenantId &&
            tenantModule.moduleId === where.moduleId,
        ) ?? null,
    },
    location: {
      findFirst: async ({ where }: { where: Where }) =>
        locations.find(
          (candidate) =>
            candidate.id === where.id && candidate.tenantId === where.tenantId,
        ) ?? null,
    },
    retailUnit: {
      findFirst: async ({ where }: { where: Where }) =>
        units.find(
          (candidate) =>
            candidate.id === where.id && candidate.tenantId === where.tenantId,
        ) ?? null,
    },
    device: {
      findFirst: async ({ where }: { where: Where }) =>
        devices.find(
          (candidate) =>
            candidate.id === where.id && candidate.tenantId === where.tenantId,
        ) ?? null,
    },
    product: {
      findFirst: async ({ where }: { where: Where }) =>
        products.find(
          (candidate) =>
            candidate.id === where.id && candidate.tenantId === where.tenantId,
        ) ?? null,
    },
    checkoutSession: {
      create: async ({
        data,
        include,
      }: {
        data: Where;
        include?: Where;
      }) => {
        if (
          data.idempotencyKey &&
          store.sessions.some(
            (row) =>
              row.tenantId === data.tenantId &&
              row.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('sess'),
          deviceId: null,
          status: 'OPEN',
          startedAt: new Date(),
          endedAt: null,
          sourceType: 'MANUAL',
          sourceId: null,
          evidenceBundleId: null,
          visionEventId: null,
          vlmReviewId: null,
          evidenceScore: null,
          evidenceQuality: null,
          reasonCodes: [],
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.sessions.push(row);
        return sessionView(row, include);
      },
      findFirst: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.sessions.find((candidate) =>
          matchesSession(candidate, where),
        );
        return row ? sessionView(row, include) : null;
      },
      findMany: async ({
        where,
        include,
        skip,
        take,
      }: {
        where: Where;
        include?: Where;
        skip?: number;
        take?: number;
      }) =>
        store.sessions
          .filter((row) => matchesSession(row, where))
          .sort(
            (a, b) =>
              (b.startedAt as Date).getTime() -
                (a.startedAt as Date).getTime() || idSeq(b.id) - idSeq(a.id),
          )
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map((row) => sessionView(row, include)),
      count: async ({ where }: { where: Where }) =>
        store.sessions.filter((row) => matchesSession(row, where)).length,
      update: async ({
        where,
        data,
        include,
      }: {
        where: Where;
        data: Where;
        include?: Where;
      }) => {
        const row = store.sessions.find(
          (candidate) => candidate.id === where.id,
        )!;
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return sessionView(row, include);
      },
    },
    checkoutSessionLine: {
      create: async ({ data }: { data: Where }) => {
        if (
          store.sessionLines.some(
            (row) =>
              row.tenantId === data.tenantId &&
              row.sessionId === data.sessionId &&
              row.productId === data.productId,
          )
        ) {
          throw { code: 'P2002' };
        }
        if (
          data.idempotencyKey &&
          store.sessionLines.some(
            (row) =>
              row.tenantId === data.tenantId &&
              row.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('line'),
          unitPriceMinor: null,
          lineTotalMinor: null,
          currencyCode: null,
          sourceType: 'MANUAL',
          sourceId: null,
          evidenceBundleId: null,
          visionEventId: null,
          vlmReviewId: null,
          evidenceScore: null,
          evidenceQuality: null,
          reasonCodes: [],
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.sessionLines.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.sessionLines.find((row) =>
          matchScalar(row, where, [
            'id',
            'tenantId',
            'sessionId',
            'productId',
            'idempotencyKey',
          ]),
        ) ?? null,
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.sessionLines.find(
          (candidate) => candidate.id === where.id,
        )!;
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.sessionLines.find(
          (candidate) => candidate.id === where.id,
        )!;
        store.sessionLines = store.sessionLines.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
    },
    order: {
      create: async ({ data }: { data: Where }) => {
        if (
          store.orders.some(
            (row) =>
              row.tenantId === data.tenantId &&
              (row.orderNumber === data.orderNumber ||
                row.checkoutSessionId === data.checkoutSessionId ||
                (data.idempotencyKey &&
                  row.idempotencyKey === data.idempotencyKey)),
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('order'),
          status: 'CONFIRMED',
          cancelledAt: null,
          cancelReason: null,
          subtotalMinor: null,
          totalMinor: null,
          currencyCode: null,
          sourceType: 'MANUAL',
          sourceId: null,
          evidenceBundleId: null,
          visionEventId: null,
          vlmReviewId: null,
          evidenceScore: null,
          evidenceQuality: null,
          reasonCodes: [],
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.orders.push(row);
        return row;
      },
      findFirst: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.orders.find((candidate) =>
          matchesOrder(candidate, where),
        );
        return row ? orderView(row, include) : null;
      },
      findUniqueOrThrow: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.orders.find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) {
          throw new Error('Order not found');
        }
        return orderView(row, include);
      },
      findMany: async ({
        where,
        include,
        skip,
        take,
      }: {
        where: Where;
        include?: Where;
        skip?: number;
        take?: number;
      }) =>
        store.orders
          .filter((row) => matchesOrder(row, where))
          .sort(
            (a, b) =>
              (b.placedAt as Date).getTime() -
                (a.placedAt as Date).getTime() || idSeq(b.id) - idSeq(a.id),
          )
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map((row) => orderView(row, include)),
      count: async ({ where }: { where: Where }) =>
        store.orders.filter((row) => matchesOrder(row, where)).length,
      updateMany: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.orders.find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.tenantId === where.tenantId &&
            (where.status?.in === undefined ||
              where.status.in.includes(candidate.status)),
        );
        if (!row) {
          return { count: 0 };
        }
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    orderLine: {
      create: async ({ data }: { data: Where }) => {
        const row = {
          id: nextId('oline'),
          sessionLineId: null,
          unitPriceMinor: null,
          lineTotalMinor: null,
          currencyCode: null,
          sourceType: 'MANUAL',
          sourceId: null,
          evidenceBundleId: null,
          visionEventId: null,
          vlmReviewId: null,
          evidenceScore: null,
          evidenceQuality: null,
          reasonCodes: [],
          createdById: null,
          createdAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.orderLines.push(row);
        return row;
      },
    },
    inventoryLevel: {
      upsert: async ({
        where,
        create,
      }: {
        where: { tenantId_locationId_productId: Where };
        create: Where;
      }) => {
        const key = where.tenantId_locationId_productId;
        const existing = store.levels.find(
          (row) =>
            row.tenantId === key.tenantId &&
            row.locationId === key.locationId &&
            row.productId === key.productId,
        );
        if (existing) {
          return existing;
        }
        const row = {
          id: nextId('level'),
          quantity: 0,
          ...stripUndefined(create),
        } as Row & { quantity: number };
        store.levels.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Where;
        data: { quantity: { increment: number } };
      }) => {
        const row = store.levels.find(
          (candidate) =>
            candidate.tenantId === where.tenantId &&
            candidate.locationId === where.locationId &&
            candidate.productId === where.productId &&
            candidate.quantity >= (where.quantity?.gte ?? 0) &&
            (where.quantity?.lte === undefined ||
              candidate.quantity <= where.quantity.lte),
        );
        if (!row) {
          return { count: 0 };
        }
        row.quantity += data.quantity.increment;
        return { count: 1 };
      },
      findUniqueOrThrow: async ({
        where,
      }: {
        where: { tenantId_locationId_productId: Where };
      }) => {
        const key = where.tenantId_locationId_productId;
        const row = store.levels.find(
          (candidate) =>
            candidate.tenantId === key.tenantId &&
            candidate.locationId === key.locationId &&
            candidate.productId === key.productId,
        );
        if (!row) {
          throw new Error('InventoryLevel not found');
        }
        return row;
      },
    },
    inventoryMovement: {
      create: async ({ data }: { data: Where }) => {
        const row = {
          id: nextId('move'),
          referenceType: null,
          referenceId: null,
          createdAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.movements.push(row);
        return row;
      },
    },
  };

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return response.body.accessToken as string;
  }

  const levelQuantity = (productId: string) =>
    store.levels.find((level) => level.productId === productId)?.quantity;

  let managerToken: string;
  let viewerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror the production bootstrap pipe — required for the
    // body-cannot-override-tenant tests (forbidNonWhitelisted).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    managerToken = await loginAs('manager@tenant-a.example', PASSWORDS.manager);
    viewerToken = await loginAs('viewer@tenant-a.example', PASSWORDS.viewer);
    adminToken = await loginAs('admin@byond.local', PASSWORDS.admin);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    auditCreateSpy.mockClear();
  });

  describe('session creation, references & idempotency', () => {
    it('unauthenticated requests are rejected', async () => {
      await request(app.getHttpServer()).get('/checkout-sessions').expect(401);
    });

    it('platform users are rejected from checkout endpoints', async () => {
      await request(app.getHttpServer())
        .get('/checkout-sessions')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });

    it('creates an OPEN session with evidence lineage; tenantId comes from the token', async () => {
      const response = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          deviceId: 'dev-a1',
          sourceType: 'VISION',
          sourceId: 'adapter-7',
          evidenceBundleId: 'bundle-001',
          visionEventId: 'vision-evt-42',
          vlmReviewId: 'vlm-rev-9',
          evidenceScore: 0.87,
          evidenceQuality: 'HIGH',
          reasonCodes: ['low-confidence', 'occlusion'],
        })
        .expect(201);

      expect(response.body.tenantId).toBe('tenant-a');
      expect(response.body.status).toBe('OPEN');
      expect(response.body.startedAt).toBeDefined();
      expect(response.body.endedAt).toBeNull();
      expect(response.body.lines).toEqual([]);
      expect(response.body.order).toBeNull();
      // Vendor-neutral evidence references round-trip verbatim.
      expect(response.body.sourceType).toBe('VISION');
      expect(response.body.sourceId).toBe('adapter-7');
      expect(response.body.evidenceBundleId).toBe('bundle-001');
      expect(response.body.visionEventId).toBe('vision-evt-42');
      expect(response.body.vlmReviewId).toBe('vlm-rev-9');
      expect(response.body.evidenceScore).toBe(0.87);
      expect(response.body.evidenceQuality).toBe('HIGH');
      expect(response.body.reasonCodes).toEqual([
        'low-confidence',
        'occlusion',
      ]);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entityType: 'CheckoutSession',
            tenantId: 'tenant-a',
            actorId: 'manager-a',
          }),
        }),
      );
    });

    it('replays the same idempotency key instead of opening a duplicate', async () => {
      const first = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          idempotencyKey: 'create-key-1',
        })
        .expect(201);
      auditCreateSpy.mockClear();
      const replay = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          idempotencyKey: 'create-key-1',
        })
        .expect(201);
      expect(replay.body.id).toBe(first.body.id);
      // A replay writes nothing — not even an audit row.
      expect(auditCreateSpy).not.toHaveBeenCalled();
      expect(
        store.sessions.filter(
          (row) => row.idempotencyKey === 'create-key-1',
        ),
      ).toHaveLength(1);
    });

    it('a tenantId in the body is rejected outright (400)', async () => {
      const before = store.sessions.length;
      await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          tenantId: 'tenant-b',
        })
        .expect(400);
      expect(store.sessions).toHaveLength(before);
    });

    it("another tenant's store, unit, or device cannot be referenced (400)", async () => {
      await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-b1', unitId: 'unit-b1' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-b1' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1', deviceId: 'dev-b1' })
        .expect(400);
    });

    it('a unit from the right tenant but the wrong store is rejected (400)', async () => {
      await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a2' })
        .expect(400);
    });

    it("lists only this tenant's sessions with a deterministic envelope", async () => {
      const response = await request(app.getHttpServer())
        .get('/checkout-sessions')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      expect(response.body).toEqual(
        expect.objectContaining({ skip: 0, take: 25 }),
      );
      expect(response.body.items.length).toBeGreaterThan(0);
      expect(
        response.body.items.every(
          (item: { tenantId: string }) => item.tenantId === 'tenant-a',
        ),
      ).toBe(true);
      const repeat = await request(app.getHttpServer())
        .get('/checkout-sessions')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      expect(repeat.body.items.map((item: { id: string }) => item.id)).toEqual(
        response.body.items.map((item: { id: string }) => item.id),
      );
    });

    it("another tenant's session is invisible (404)", async () => {
      await request(app.getHttpServer())
        .get('/checkout-sessions/sess-b')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(404);
    });
  });

  describe('basket lines', () => {
    let sessionId: string;
    let lineId: string;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1' })
        .expect(201);
      sessionId = response.body.id;
    });

    it('adds a line snapshotting the product and carrying evidence refs', async () => {
      const response = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          productId: 'prod-a1',
          quantity: 2,
          sourceType: 'VISION',
          visionEventId: 'vision-evt-77',
          evidenceScore: 0.91,
        })
        .expect(201);
      lineId = response.body.id;
      // Snapshot at add time — later product edits must not rewrite it.
      expect(response.body.sku).toBe('A-COLA-330');
      expect(response.body.productName).toBe('Cola 330ml');
      expect(response.body.unitOfMeasure).toBe('EACH');
      expect(response.body.quantity).toBe(2);
      expect(response.body.visionEventId).toBe('vision-evt-77');
      // Pricing stays a null placeholder until the pricing/payment phases.
      expect(response.body.unitPriceMinor).toBeNull();
      expect(response.body.lineTotalMinor).toBeNull();
      expect(response.body.currencyCode).toBeNull();
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entityType: 'CheckoutSessionLine',
            tenantId: 'tenant-a',
          }),
        }),
      );
    });

    it('rejects a second line for the same product (409)', async () => {
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-a1', quantity: 1 })
        .expect(409);
    });

    it('replays an add-line idempotency key instead of duplicating', async () => {
      const first = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          productId: 'prod-a2',
          quantity: 1,
          idempotencyKey: 'line-key-1',
        })
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          productId: 'prod-a2',
          quantity: 5,
          idempotencyKey: 'line-key-1',
        })
        .expect(201);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.quantity).toBe(1); // original, untouched
    });

    it('a non-ACTIVE product is not saleable (409)', async () => {
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-draft', quantity: 1 })
        .expect(409);
    });

    it("another tenant's product cannot enter the basket (404)", async () => {
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-b', quantity: 1 })
        .expect(404);
      expect(
        store.sessionLines.some((line) => line.productId === 'prod-b'),
      ).toBe(false);
    });

    it('zero and negative quantities are rejected at validation (400)', async () => {
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-a1', quantity: 0 })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ quantity: -1 })
        .expect(400);
    });

    it('updates a line quantity and audits before/after', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ quantity: 3 })
        .expect(200);
      expect(response.body.quantity).toBe(3);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPDATE',
            entityType: 'CheckoutSessionLine',
            entityId: lineId,
          }),
        }),
      );
    });

    it('an empty line update is rejected (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/lines/${lineId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(400);
    });

    it('removes a line (204) and audits the deletion', async () => {
      await request(app.getHttpServer())
        .delete(
          `/checkout-sessions/${sessionId}/lines/${
            store.sessionLines.find(
              (line) =>
                line.sessionId === sessionId && line.productId === 'prod-a2',
            )!.id
          }`,
        )
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'DELETE',
            entityType: 'CheckoutSessionLine',
          }),
        }),
      );
      expect(
        store.sessionLines.some(
          (line) =>
            line.sessionId === sessionId && line.productId === 'prod-a2',
        ),
      ).toBe(false);
    });

    it('a missing line 404s', async () => {
      await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/lines/line-nope`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ quantity: 2 })
        .expect(404);
    });
  });

  describe('lifecycle transitions & terminal protection', () => {
    let sessionId: string;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1' })
        .expect(201);
      sessionId = response.body.id;
    });

    it('walks OPEN → ACTIVE → PENDING_REVIEW → ACTIVE', async () => {
      for (const status of ['ACTIVE', 'PENDING_REVIEW', 'ACTIVE'] as const) {
        const response = await request(app.getHttpServer())
          .patch(`/checkout-sessions/${sessionId}/status`)
          .set('Authorization', `Bearer ${managerToken}`)
          .send({ status })
          .expect(200);
        expect(response.body.status).toBe(status);
        expect(response.body.endedAt).toBeNull();
      }
    });

    it('rejects an illegal transition (ACTIVE → ACTIVE) with 409', async () => {
      await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(409);
    });

    it('COMPLETED is not a patchable status (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'COMPLETED' })
        .expect(400);
    });

    it('cancelling sets endedAt and audits CANCEL', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'CANCELLED', reason: 'Shopper walked away' })
        .expect(200);
      expect(response.body.status).toBe('CANCELLED');
      expect(response.body.endedAt).not.toBeNull();
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CANCEL',
            entityType: 'CheckoutSession',
            entityId: sessionId,
            reason: 'Shopper walked away',
          }),
        }),
      );
    });

    it('a terminal session rejects every further mutation (409)', async () => {
      await request(app.getHttpServer())
        .patch(`/checkout-sessions/${sessionId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(409);
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-a1', quantity: 1 })
        .expect(409);
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(409);
    });

    it('expiring another session sets endedAt and audits EXPIRE', async () => {
      const created = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1' })
        .expect(201);
      const response = await request(app.getHttpServer())
        .patch(`/checkout-sessions/${created.body.id}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'EXPIRED' })
        .expect(200);
      expect(response.body.status).toBe('EXPIRED');
      expect(response.body.endedAt).not.toBeNull();
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'EXPIRE' }),
        }),
      );
    });
  });

  describe('completion → order (atomicity, inventory, idempotency)', () => {
    let sessionId: string;
    let colaLineId: string;
    let orderId: string;

    beforeAll(async () => {
      const session = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          sourceType: 'VISION',
          evidenceBundleId: 'bundle-complete-1',
          reasonCodes: ['walkout'],
        })
        .expect(201);
      sessionId = session.body.id;
      const cola = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          productId: 'prod-a1',
          quantity: 4,
          sourceType: 'VISION',
          visionEventId: 'vision-evt-cola',
        })
        .expect(201);
      colaLineId = cola.body.id;
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-a2', quantity: 5 }) // stock is only 2
        .expect(201);
    });

    it('completing an empty session is rejected (409)', async () => {
      const empty = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${empty.body.id}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'complete-empty' })
        .expect(409);
    });

    it('insufficient stock on ONE line rolls back the WHOLE completion', async () => {
      const ordersBefore = store.orders.length;
      const movementsBefore = store.movements.length;
      const response = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'complete-key-1' })
        .expect(409);
      // The 409 names the SKU that could not be consumed.
      expect(JSON.stringify(response.body)).toContain('A-CHIPS-50');
      // Nothing survived: no order, no order lines, no movements, levels
      // untouched (INCLUDING the sufficient cola line), session not
      // terminal, basket intact.
      expect(store.orders).toHaveLength(ordersBefore);
      expect(store.orderLines).toHaveLength(0);
      expect(store.movements).toHaveLength(movementsBefore);
      expect(levelQuantity('prod-a1')).toBe(100);
      expect(levelQuantity('prod-a2')).toBe(2);
      const session = await request(app.getHttpServer())
        .get(`/checkout-sessions/${sessionId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(session.body.status).not.toBe('COMPLETED');
      expect(session.body.lines).toHaveLength(2);
      expect(session.body.order).toBeNull();
    });

    it('completes atomically once stock suffices: order, lines, movements, session flip', async () => {
      // Make the chips line satisfiable, then complete for real.
      await request(app.getHttpServer())
        .patch(
          `/checkout-sessions/${sessionId}/lines/${
            store.sessionLines.find(
              (line) =>
                line.sessionId === sessionId && line.productId === 'prod-a2',
            )!.id
          }`,
        )
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ quantity: 2 })
        .expect(200);
      auditCreateSpy.mockClear();

      const response = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'complete-key-1' })
        .expect(201);
      orderId = response.body.id;

      // The order is CONFIRMED — which means "inventory consumed", never
      // "paid": pricing/payment fields are null placeholders.
      expect(response.body.orderNumber).toMatch(/^ORD-\d{6}$/);
      expect(response.body.status).toBe('CONFIRMED');
      expect(response.body.confirmedAt).not.toBeNull();
      expect(response.body.totalQuantity).toBe(6);
      expect(response.body.subtotalMinor).toBeNull();
      expect(response.body.totalMinor).toBeNull();
      expect(response.body.currencyCode).toBeNull();
      // Evidence lineage copied from the session.
      expect(response.body.sourceType).toBe('VISION');
      expect(response.body.evidenceBundleId).toBe('bundle-complete-1');
      expect(response.body.reasonCodes).toEqual(['walkout']);

      // Order lines snapshot the basket lines and keep lineage.
      expect(response.body.lines).toHaveLength(2);
      const colaLine = response.body.lines.find(
        (line: { sku: string }) => line.sku === 'A-COLA-330',
      );
      expect(colaLine).toEqual(
        expect.objectContaining({
          productName: 'Cola 330ml',
          unitOfMeasure: 'EACH',
          quantity: 4,
          sessionLineId: colaLineId,
          visionEventId: 'vision-evt-cola',
          unitPriceMinor: null,
        }),
      );

      // Inventory: SALE movements reference the order; levels decremented.
      const saleMovements = store.movements.filter(
        (movement) => movement.movementType === 'SALE',
      );
      expect(saleMovements).toHaveLength(2);
      expect(
        saleMovements.every(
          (movement) =>
            movement.referenceType === 'Order' &&
            movement.referenceId === orderId &&
            movement.tenantId === 'tenant-a',
        ),
      ).toBe(true);
      expect(
        saleMovements
          .map((movement) => Number(movement.quantityDelta))
          .sort((a, b) => a - b),
      ).toEqual([-4, -2]);
      expect(levelQuantity('prod-a1')).toBe(96);
      expect(levelQuantity('prod-a2')).toBe(0);

      // Session flipped to COMPLETED and now links to its order.
      const session = await request(app.getHttpServer())
        .get(`/checkout-sessions/${sessionId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(session.body.status).toBe('COMPLETED');
      expect(session.body.endedAt).not.toBeNull();
      expect(session.body.order).toEqual({
        id: orderId,
        orderNumber: response.body.orderNumber,
        status: 'CONFIRMED',
      });

      // Audits: session COMPLETE, order CREATE, stock consumption per line.
      const auditedActions = auditCreateSpy.mock.calls.map(
        (call) => (call[0] as { data: { action: string } }).data.action,
      );
      expect(auditedActions).toEqual(
        expect.arrayContaining(['COMPLETE', 'CREATE', 'STOCK_ADJUSTMENT']),
      );
      expect(
        auditedActions.filter((action) => action === 'STOCK_ADJUSTMENT'),
      ).toHaveLength(2);
    });

    it('replaying the completion key returns the SAME order with zero new writes', async () => {
      const ordersBefore = store.orders.length;
      const movementsBefore = store.movements.length;
      const response = await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'complete-key-1' })
        .expect(201);
      expect(response.body.id).toBe(orderId);
      expect(store.orders).toHaveLength(ordersBefore);
      expect(store.movements).toHaveLength(movementsBefore);
      expect(levelQuantity('prod-a1')).toBe(96);
    });

    it('re-completing WITHOUT the original key is a conflict (409)', async () => {
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(409);
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'some-other-key' })
        .expect(409);
    });

    it('order numbers stay unique per tenant across completions', async () => {
      const session = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${session.body.id}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ productId: 'prod-a1', quantity: 1 })
        .expect(201);
      const response = await request(app.getHttpServer())
        .post(`/checkout-sessions/${session.body.id}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'complete-key-2' })
        .expect(201);
      const tenantAOrders = store.orders.filter(
        (order) => order.tenantId === 'tenant-a',
      );
      expect(new Set(tenantAOrders.map((order) => order.orderNumber)).size).toBe(
        tenantAOrders.length,
      );
      expect(response.body.orderNumber).not.toBe(
        store.orders.find((order) => order.id === orderId)!.orderNumber,
      );
    });
  });

  describe('orders: list, detail, cancel & tenant isolation', () => {
    it('lists only tenant-a orders, deterministically, with filters', async () => {
      const response = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(response.body.items.length).toBeGreaterThanOrEqual(2);
      expect(
        response.body.items.every(
          (item: { tenantId: string }) => item.tenantId === 'tenant-a',
        ),
      ).toBe(true);
      const repeat = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(repeat.body.items.map((item: { id: string }) => item.id)).toEqual(
        response.body.items.map((item: { id: string }) => item.id),
      );

      const filtered = await request(app.getHttpServer())
        .get(`/orders?orderNumber=${response.body.items[0].orderNumber}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(filtered.body.total).toBe(1);
      expect(filtered.body.items[0].id).toBe(response.body.items[0].id);
    });

    it("another tenant's order is invisible (404)", async () => {
      await request(app.getHttpServer())
        .get('/orders/order-b')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(404);
      const list = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(
        list.body.items.some((item: { id: string }) => item.id === 'order-b'),
      ).toBe(false);
    });

    it('order detail keeps full lineage back to the session', async () => {
      const list = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const detail = await request(app.getHttpServer())
        .get(`/orders/${list.body.items[0].id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(detail.body.session).toEqual(
        expect.objectContaining({ status: 'COMPLETED' }),
      );
      expect(detail.body.lines.length).toBeGreaterThan(0);
      expect(detail.body.lines[0].sessionLineId).toBeDefined();
    });

    it('cancels an order (status only — stock is NOT restored) and audits CANCEL', async () => {
      const list = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const target = list.body.items[0].id as string;
      const colaBefore = levelQuantity('prod-a1');
      const response = await request(app.getHttpServer())
        .post(`/orders/${target}/cancel`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ reason: 'Test cancellation' })
        .expect(200);
      expect(response.body.status).toBe('CANCELLED');
      expect(response.body.cancelledAt).not.toBeNull();
      expect(response.body.cancelReason).toBe('Test cancellation');
      // Phase 5 cancellation never fakes a return.
      expect(levelQuantity('prod-a1')).toBe(colaBefore);
      expect(
        store.movements.filter((m) => m.movementType === 'SALE'),
      ).toHaveLength(3);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CANCEL',
            entityType: 'Order',
            entityId: target,
          }),
        }),
      );

      await request(app.getHttpServer())
        .post(`/orders/${target}/cancel`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(409);
    });
  });

  describe('RBAC & module gating', () => {
    it('checkout:read alone cannot mutate; the denial is audited', async () => {
      await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ locationId: 'loc-a1', unitId: 'unit-a1' })
        .expect(403);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACCESS_DENIED' }),
        }),
      );
      const anySession = store.sessions.find(
        (row) => row.tenantId === 'tenant-a',
      )!;
      await request(app.getHttpServer())
        .post(`/checkout-sessions/${anySession.id}/complete`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({})
        .expect(403);
    });

    it('without order:read the orders endpoints are closed', async () => {
      await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .post('/orders/whatever/cancel')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({})
        .expect(403);
    });

    it('a disabled checkout module blocks BOTH controllers despite full RBAC', async () => {
      const checkoutModule = tenantModules.find(
        (tm) => tm.moduleId === 'module-checkout',
      )!;
      const previous = checkoutModule.status;
      checkoutModule.status = 'DISABLED';
      try {
        await request(app.getHttpServer())
          .get('/checkout-sessions')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
        await request(app.getHttpServer())
          .get('/orders')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
        expect(auditCreateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ action: 'ACCESS_DENIED' }),
          }),
        );
      } finally {
        checkoutModule.status = previous;
      }
      await request(app.getHttpServer())
        .get('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
    });
  });

  describe('evidence vendor-neutrality', () => {
    it('opaque evidence references flow session → line → order line with no CV/VLM provider anywhere', async () => {
      const session = await request(app.getHttpServer())
        .post('/checkout-sessions')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          sourceType: 'DEVICE',
          sourceId: 'any-future-adapter:42',
          evidenceBundleId: 'opaque-bundle-xyz',
          vlmReviewId: 'opaque-review-1',
          evidenceQuality: 'MEDIUM',
        })
        .expect(201);
      const line = await request(app.getHttpServer())
        .post(`/checkout-sessions/${session.body.id}/lines`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          productId: 'prod-a1',
          quantity: 1,
          sourceType: 'VISION',
          visionEventId: 'opaque-vision-evt',
          evidenceScore: 0.5,
          reasonCodes: ['manual-correction'],
        })
        .expect(201);
      const completed = await request(app.getHttpServer())
        .post(`/checkout-sessions/${session.body.id}/complete`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ idempotencyKey: 'complete-evidence' })
        .expect(201);

      // The order carries the session's lineage; the order line carries the
      // basket line's — all verbatim opaque strings. Nothing in the API
      // required a vision provider, a model, or any CV implementation to
      // accept, store, or return them.
      expect(completed.body.sourceType).toBe('DEVICE');
      expect(completed.body.sourceId).toBe('any-future-adapter:42');
      expect(completed.body.evidenceBundleId).toBe('opaque-bundle-xyz');
      expect(completed.body.vlmReviewId).toBe('opaque-review-1');
      expect(completed.body.evidenceQuality).toBe('MEDIUM');
      expect(completed.body.lines[0]).toEqual(
        expect.objectContaining({
          sourceType: 'VISION',
          visionEventId: 'opaque-vision-evt',
          evidenceScore: 0.5,
          reasonCodes: ['manual-correction'],
          sessionLineId: line.body.id,
        }),
      );
    });
  });
});
