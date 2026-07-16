import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Deterministic in-memory fixture — no live database (same pattern as
// checkout-orders.e2e-spec). Secret-shaped inputs are BUILT AT RUNTIME so no
// static secret/PAN is ever committed (Gitleaks-safe).
const PASSWORDS = {
  admin: 'admin-local-password',
  manager: 'manager-local-password',
  viewer: 'viewer-local-password',
  managerC: 'manager-c-local-password',
};
const TEST_PAN = ['4111', '1111', '1111', '1111'].join(''); // Luhn-valid
const TEST_SECRET = ['sk', 'live', '0a1b2c3d4e5f6g7h8i9j'].join('_');

interface Row {
  [key: string]: unknown;
  id: string;
  tenantId: string;
}

describe('Payments & reconciliation (e2e, no live database)', () => {
  let app: INestApplication;
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;
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
    {
      id: 'manager-c',
      tenantId: 'tenant-c',
      userType: 'TENANT',
      email: 'manager@tenant-c.example',
      firstName: 'Cee',
      lastName: 'Manager',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.managerC, 4),
      lastLoginAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    },
  ];

  // viewer-a holds only the read permissions (exercises RBAC denial paths);
  // manager-c holds full payment permissions but tenant-c has the payments
  // MODULE DISABLED (no tenantModule row) — exercises module gating.
  const grants: Record<string, { tenantId: string | null; codes: string[] }> =
    {
      'admin-1': { tenantId: null, codes: ['tenant:read', 'module:read'] },
      'manager-a': {
        tenantId: 'tenant-a',
        codes: [
          'payment:read',
          'payment:manage',
          'payment:simulate',
          'reconciliation:read',
          'reconciliation:manage',
          'order:read',
        ],
      },
      'viewer-a': {
        tenantId: 'tenant-a',
        codes: ['payment:read', 'reconciliation:read'],
      },
      'manager-c': {
        tenantId: 'tenant-c',
        codes: ['payment:read', 'payment:manage', 'payment:simulate'],
      },
    };

  const platformModules = [
    { id: 'module-core', code: 'core', name: 'Core', isActive: true },
    {
      id: 'module-payments',
      code: 'payments',
      name: 'Payments & Reconciliation',
      isActive: true,
    },
  ];
  // tenant-a enabled; tenant-c deliberately absent (module-disabled test).
  const tenantModules = [
    {
      id: 'tm-a-payments',
      tenantId: 'tenant-a',
      moduleId: 'module-payments',
      status: 'ENABLED',
    },
  ];

  // Cross-tenant "bait": tenant-b rows must stay invisible to tenant-a.
  const store = {
    orders: [
      {
        id: 'order-a1',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000001',
        checkoutSessionId: 'sess-a1',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      {
        id: 'order-a2',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000002',
        checkoutSessionId: 'sess-a2',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      {
        id: 'order-b',
        tenantId: 'tenant-b',
        orderNumber: 'ORD-000001',
        checkoutSessionId: 'sess-b',
        locationId: 'loc-b1',
        unitId: 'unit-b1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
    ] as Row[],
    sessions: [
      { id: 'sess-a1', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-a2', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-b', tenantId: 'tenant-b', status: 'COMPLETED' },
    ] as Row[],
    intents: [
      {
        id: 'pi-b',
        tenantId: 'tenant-b',
        orderId: 'order-b',
        checkoutSessionId: null,
        provider: 'SIMULATED',
        status: 'CREATED',
        amountMinor: 999,
        currencyCode: 'SAR',
        capturedAmountMinor: 0,
        providerRef: null,
        providerCustomerRef: null,
        instrumentBrand: null,
        instrumentLast4: null,
        instrumentExpiryMonth: null,
        instrumentExpiryYear: null,
        instrumentWallet: null,
        description: null,
        failureReason: null,
        authorizedAt: null,
        capturedAt: null,
        cancelledAt: null,
        failedAt: null,
        expiresAt: null,
        idempotencyKey: null,
        createdById: null,
        createdAt: new Date('2026-07-12T00:00:00Z'),
        updatedAt: new Date('2026-07-12T00:00:00Z'),
      },
    ] as Row[],
    authorizations: [] as Row[],
    captures: [] as Row[],
    events: [] as Row[],
    reconciliations: [] as Row[],
  };

  const auditCreateSpy = jest.fn().mockResolvedValue({});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Where = Record<string, any>;

  const scalarMatch = (row: Row, where: Where, keys: string[]) =>
    keys.every((k) => where[k] === undefined || row[k] === where[k]);

  const stripUndefined = (data: Where): Where & { tenantId: string } =>
    Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined),
    ) as Where & { tenantId: string };

  const byCreatedDesc = (a: Row, b: Row) =>
    (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime() ||
    idSeq(b.id) - idSeq(a.id);

  const childList = (rows: Row[], intentId: string) =>
    rows
      .filter((r) => r.intentId === intentId)
      .sort((a, b) => idSeq(a.id) - idSeq(b.id));

  function intentRefs(row: Row): Row {
    const order = store.orders.find((o) => o.id === row.orderId);
    const session = store.sessions.find((s) => s.id === row.checkoutSessionId);
    return {
      ...row,
      order: order
        ? {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            paymentStatus: order.paymentStatus,
          }
        : null,
      session: session ? { id: session.id, status: session.status } : null,
    };
  }

  function intentView(row: Row, include?: Where): Row {
    if (!include) {
      return { ...row };
    }
    const view = include.order || include.session ? intentRefs(row) : { ...row };
    if (include.authorizations) {
      view.authorizations = childList(store.authorizations, row.id);
    }
    if (include.captures) {
      view.captures = childList(store.captures, row.id);
    }
    if (include.events) {
      view.events = childList(store.events, row.id);
    }
    if (include.reconciliationRecords) {
      view.reconciliationRecords = childList(store.reconciliations, row.id);
    }
    return view;
  }

  const captureView = (row: Row) => {
    const intent = store.intents.find((i) => i.id === row.intentId);
    return {
      ...row,
      intent: intent
        ? { id: intent.id, status: intent.status, orderId: intent.orderId }
        : null,
    };
  };

  const eventView = (row: Row) => {
    const intent = store.intents.find((i) => i.id === row.intentId);
    return {
      ...row,
      intent: intent ? { id: intent.id, status: intent.status } : null,
    };
  };

  const reconView = (row: Row) => {
    const intent = store.intents.find((i) => i.id === row.intentId);
    return {
      ...row,
      intent: intent
        ? {
            id: intent.id,
            status: intent.status,
            provider: intent.provider,
            orderId: intent.orderId,
          }
        : null,
    };
  };

  const mutableTables = [
    'orders',
    'intents',
    'authorizations',
    'captures',
    'events',
    'reconciliations',
  ] as const;

  const prismaStub = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Tenant"')
        ? Promise.resolve([{ status: 'ACTIVE' }])
        : Promise.resolve([1]),
    ),
    $transaction: async (callback: (tx: unknown) => unknown) => {
      const snapshot = structuredClone(
        Object.fromEntries(mutableTables.map((t) => [t, store[t]])),
      ) as Record<(typeof mutableTables)[number], Row[]>;
      try {
        return await callback(prismaStub);
      } catch (error) {
        for (const t of mutableTables) {
          (store[t] as Row[]).length = 0;
          (store[t] as Row[]).push(...snapshot[t]);
        }
        throw error;
      }
    },
    user: {
      findUnique: async ({ where }: { where: Where }) =>
        users.find(
          (u) =>
            (where.email && u.email === where.email) ||
            (where.id && u.id === where.id),
        ) ?? null,
      findFirst: async ({ where }: { where: Where }) => {
        const found = users.find(
          (u) =>
            (where.id === undefined || u.id === where.id) &&
            (where.email === undefined || u.email === where.email) &&
            (where.tenantId === undefined || u.tenantId === where.tenantId) &&
            (where.status === undefined || u.status === where.status),
        );
        return found
          ? { ...found, tenant: found.tenantId ? { status: 'ACTIVE' } : null }
          : null;
      },
      updateMany: async ({ where }: { where: Where }) => ({
        count: users.some((u) => u.id === where.id) ? 1 : 0,
      }),
      update: async ({ where }: { where: Where }) =>
        users.find((u) => u.id === where.id),
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
        platformModules.find((m) => m.code === where.code) ?? null,
    },
    tenantModule: {
      findFirst: async ({ where }: { where: Where }) =>
        tenantModules.find(
          (tm) =>
            tm.tenantId === where.tenantId && tm.moduleId === where.moduleId,
        ) ?? null,
    },
    checkoutSession: {
      findFirst: async ({ where }: { where: Where }) =>
        store.sessions.find(
          (s) => s.id === where.id && s.tenantId === where.tenantId,
        ) ?? null,
    },
    order: {
      findFirst: async ({ where }: { where: Where }) =>
        store.orders.find((o) => scalarMatch(o, where, ['id', 'tenantId'])) ??
        null,
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.orders.find((o) => o.id === where.id)!;
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return { ...row };
      },
    },
    paymentIntent: {
      create: async ({ data, include }: { data: Where; include?: Where }) => {
        if (
          data.idempotencyKey &&
          store.intents.some(
            (r) =>
              r.tenantId === data.tenantId &&
              r.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('pi'),
          provider: 'SIMULATED',
          status: 'CREATED',
          capturedAmountMinor: 0,
          orderId: null,
          checkoutSessionId: null,
          providerRef: null,
          providerCustomerRef: null,
          instrumentBrand: null,
          instrumentLast4: null,
          instrumentExpiryMonth: null,
          instrumentExpiryYear: null,
          instrumentWallet: null,
          description: null,
          failureReason: null,
          authorizedAt: null,
          capturedAt: null,
          cancelledAt: null,
          failedAt: null,
          expiresAt: null,
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.intents.push(row);
        return intentView(row, include);
      },
      findFirst: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.intents.find((r) =>
          scalarMatch(r, where, [
            'id',
            'tenantId',
            'idempotencyKey',
            'status',
            'provider',
            'orderId',
            'checkoutSessionId',
          ]),
        );
        return row ? intentView(row, include) : null;
      },
      findFirstOrThrow: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.intents.find((r) =>
          scalarMatch(r, where, ['id', 'tenantId']),
        );
        if (!row) {
          throw new Error('PaymentIntent not found');
        }
        return intentView(row, include);
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
        store.intents
          .filter((r) =>
            scalarMatch(r, where, [
              'tenantId',
              'status',
              'provider',
              'orderId',
              'checkoutSessionId',
            ]),
          )
          .sort(byCreatedDesc)
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map((row) => intentView(row, include)),
      count: async ({ where }: { where: Where }) =>
        store.intents.filter((r) =>
          scalarMatch(r, where, [
            'tenantId',
            'status',
            'provider',
            'orderId',
            'checkoutSessionId',
          ]),
        ).length,
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.intents.find((r) => r.id === where.id)!;
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return { ...row };
      },
    },
    paymentAuthorization: {
      create: async ({ data }: { data: Where }) => {
        if (
          data.idempotencyKey &&
          store.authorizations.some(
            (r) =>
              r.tenantId === data.tenantId &&
              r.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('auth'),
          providerRef: null,
          expiresAt: null,
          voidedAt: null,
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.authorizations.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.authorizations.find((r) =>
          scalarMatch(r, where, [
            'tenantId',
            'idempotencyKey',
            'intentId',
            'status',
          ]),
        ) ?? null,
      updateMany: async ({ where, data }: { where: Where; data: Where }) => {
        let count = 0;
        for (const row of store.authorizations) {
          if (scalarMatch(row, where, ['tenantId', 'intentId', 'status'])) {
            Object.assign(row, stripUndefined(data));
            count += 1;
          }
        }
        return { count };
      },
    },
    paymentCapture: {
      create: async ({ data }: { data: Where }) => {
        if (
          data.idempotencyKey &&
          store.captures.some(
            (r) =>
              r.tenantId === data.tenantId &&
              r.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('cap'),
          providerRef: null,
          capturedAt: null,
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.captures.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.captures.find((r) =>
          scalarMatch(r, where, [
            'tenantId',
            'idempotencyKey',
            'intentId',
            'status',
          ]),
        ) ?? null,
      findMany: async ({
        where,
        skip,
        take,
      }: {
        where: Where;
        skip?: number;
        take?: number;
      }) =>
        store.captures
          .filter((r) => scalarMatch(r, where, ['tenantId', 'status', 'intentId']))
          .sort(byCreatedDesc)
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map(captureView),
      count: async ({ where }: { where: Where }) =>
        store.captures.filter((r) =>
          scalarMatch(r, where, ['tenantId', 'status', 'intentId']),
        ).length,
    },
    paymentReconciliationRecord: {
      create: async ({ data }: { data: Where }) => {
        const row = {
          id: nextId('recon'),
          status: 'PENDING',
          providerRef: null,
          captureId: null,
          expectedAmountMinor: null,
          reportedAmountMinor: null,
          currencyCode: null,
          notes: null,
          reconciledAt: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.reconciliations.push(row);
        return { ...row };
      },
      findFirst: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.reconciliations.find((r) =>
          scalarMatch(r, where, ['id', 'tenantId', 'intentId', 'status']),
        );
        return row ? (include ? reconView(row) : { ...row }) : null;
      },
      findMany: async ({
        where,
        skip,
        take,
      }: {
        where: Where;
        skip?: number;
        take?: number;
      }) =>
        store.reconciliations
          .filter((r) => scalarMatch(r, where, ['tenantId', 'status', 'intentId']))
          .sort(byCreatedDesc)
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map(reconView),
      count: async ({ where }: { where: Where }) =>
        store.reconciliations.filter((r) =>
          scalarMatch(r, where, ['tenantId', 'status', 'intentId']),
        ).length,
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.reconciliations.find((r) => r.id === where.id)!;
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return reconView(row);
      },
    },
    paymentEvent: {
      create: async ({ data, include }: { data: Where; include?: Where }) => {
        if (
          store.events.some(
            (r) =>
              r.tenantId === data.tenantId &&
              r.provider === data.provider &&
              r.providerEventId === data.providerEventId,
          ) ||
          (data.idempotencyKey &&
            store.events.some(
              (r) =>
                r.tenantId === data.tenantId &&
                r.idempotencyKey === data.idempotencyKey,
            ))
        ) {
          throw { code: 'P2002' };
        }
        const row = {
          id: nextId('pe'),
          intentId: null,
          provider: 'SIMULATED',
          status: 'RECEIVED',
          providerRef: null,
          receivedAt: new Date(),
          processedAt: null,
          idempotencyKey: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...stripUndefined(data),
        } as Row;
        store.events.push(row);
        return include ? eventView(row) : { ...row };
      },
      findFirst: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.events.find((r) =>
          scalarMatch(r, where, [
            'id',
            'tenantId',
            'provider',
            'providerEventId',
            'idempotencyKey',
            'status',
            'eventType',
            'intentId',
          ]),
        );
        return row ? (include ? eventView(row) : { ...row }) : null;
      },
      findMany: async ({
        where,
        skip,
        take,
      }: {
        where: Where;
        skip?: number;
        take?: number;
      }) =>
        store.events
          .filter((r) =>
            scalarMatch(r, where, [
              'tenantId',
              'status',
              'provider',
              'eventType',
              'intentId',
            ]),
          )
          .sort(
            (a, b) =>
              (b.receivedAt as Date).getTime() -
                (a.receivedAt as Date).getTime() || idSeq(b.id) - idSeq(a.id),
          )
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map(eventView),
      count: async ({ where }: { where: Where }) =>
        store.events.filter((r) =>
          scalarMatch(r, where, [
            'tenantId',
            'status',
            'provider',
            'eventType',
            'intentId',
          ]),
        ).length,
    },
  };

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return response.body.accessToken as string;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const orderPaymentStatus = (id: string) =>
    store.orders.find((o) => o.id === id)?.paymentStatus;

  let managerToken: string;
  let viewerToken: string;
  let adminToken: string;
  let managerCToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication();
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
    managerCToken = await loginAs(
      'manager@tenant-c.example',
      PASSWORDS.managerC,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    auditCreateSpy.mockClear();
  });

  const createIntent = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/payments/intents')
      .set(auth(token))
      .send(body);

  describe('access control & module gating', () => {
    it('rejects unauthenticated requests', async () => {
      await request(app.getHttpServer()).get('/payments/intents').expect(401);
    });

    it('rejects platform users (TenantOnly)', async () => {
      await request(app.getHttpServer())
        .get('/payments/intents')
        .set(auth(adminToken))
        .expect(403);
    });

    it('denies a tenant whose payments module is disabled (fail closed)', async () => {
      await request(app.getHttpServer())
        .get('/payments/intents')
        .set(auth(managerCToken))
        .expect(403);
    });

    it('denies payment:read holders from creating intents (RBAC)', async () => {
      await createIntent(viewerToken, {
        amountMinor: 1000,
        currencyCode: 'SAR',
      }).expect(403);
    });

    it('denies payment:read holders from simulate actions (RBAC)', async () => {
      const { body } = await createIntent(managerToken, {
        amountMinor: 1000,
        currencyCode: 'SAR',
      }).expect(201);
      await request(app.getHttpServer())
        .post(`/payments/intents/${body.id}/authorize`)
        .set(auth(viewerToken))
        .send({})
        .expect(403);
    });
  });

  describe('intent creation, tenant scoping & sensitive input', () => {
    it('creates a CREATED intent; tenantId comes from the token, not the body', async () => {
      const { body } = await createIntent(managerToken, {
        tenantId: 'tenant-b',
        amountMinor: 1500,
        currencyCode: 'SAR',
        orderId: 'order-a1',
      }).expect(400); // forbidNonWhitelisted rejects the body tenantId
      expect(body.message).toBeDefined();

      const ok = await createIntent(managerToken, {
        amountMinor: 1500,
        currencyCode: 'SAR',
        orderId: 'order-a1',
        instrumentBrand: 'VISA',
        instrumentLast4: '4242',
      }).expect(201);
      expect(ok.body.status).toBe('CREATED');
      expect(ok.body.tenantId).toBe('tenant-a');
      expect(ok.body.order.id).toBe('order-a1');
    });

    it('rejects linking another tenant’s order (cross-tenant)', async () => {
      await createIntent(managerToken, {
        amountMinor: 500,
        currencyCode: 'SAR',
        orderId: 'order-b',
      }).expect(400);
    });

    it('rejects a providerRef carrying a raw card number', async () => {
      await createIntent(managerToken, {
        amountMinor: 500,
        currencyCode: 'SAR',
        providerRef: TEST_PAN,
      }).expect(400);
    });

    it('rejects an idempotencyKey carrying a secret token', async () => {
      await createIntent(managerToken, {
        amountMinor: 500,
        currencyCode: 'SAR',
        idempotencyKey: TEST_SECRET,
      }).expect(400);
    });

    it('rejects an instrumentLast4 that is not exactly four digits (no PAN storage)', async () => {
      await createIntent(managerToken, {
        amountMinor: 500,
        currencyCode: 'SAR',
        instrumentLast4: TEST_PAN,
      }).expect(400);
    });

    it('replays the same intent for a duplicate create idempotencyKey', async () => {
      const first = await createIntent(managerToken, {
        amountMinor: 700,
        currencyCode: 'SAR',
        idempotencyKey: 'create-key-1',
      }).expect(201);
      const second = await createIntent(managerToken, {
        amountMinor: 700,
        currencyCode: 'SAR',
        idempotencyKey: 'create-key-1',
      }).expect(201);
      expect(second.body.id).toBe(first.body.id);
    });

    it('hides another tenant’s intent (404, not 403)', async () => {
      await request(app.getHttpServer())
        .get('/payments/intents/pi-b')
        .set(auth(managerToken))
        .expect(404);
    });
  });

  describe('simulated lifecycle & order linkage', () => {
    it('authorize then capture marks the order PAID (only capture pays)', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 2500,
        currencyCode: 'SAR',
        orderId: 'order-a1',
      }).expect(201);
      const id = intent.body.id;

      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/authorize`)
        .set(auth(managerToken))
        .send({ providerRef: 'auth-ref-1' })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('AUTHORIZED'));
      expect(orderPaymentStatus('order-a1')).toBe('AUTHORIZED');

      const captured = await request(app.getHttpServer())
        .post(`/payments/intents/${id}/capture`)
        .set(auth(managerToken))
        .send({ idempotencyKey: 'cap-key-1' })
        .expect(200);
      expect(captured.body.status).toBe('CAPTURED');
      expect(captured.body.capturedAmountMinor).toBe(2500);
      expect(orderPaymentStatus('order-a1')).toBe('PAID');

      // A PENDING reconciliation record was seeded on capture.
      const recon = await request(app.getHttpServer())
        .get(`/reconciliation/records?intentId=${id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(recon.body.total).toBe(1);
      expect(recon.body.items[0].status).toBe('PENDING');
      expect(recon.body.items[0].expectedAmountMinor).toBe(2500);
    });

    it('does not double-capture on a duplicate idempotencyKey', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 300,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/authorize`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/capture`)
        .set(auth(managerToken))
        .send({ idempotencyKey: 'dup-cap' })
        .expect(200);
      // Replay: same key, same intent → still CAPTURED, no second capture.
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/capture`)
        .set(auth(managerToken))
        .send({ idempotencyKey: 'dup-cap' })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('CAPTURED'));
      const caps = await request(app.getHttpServer())
        .get(`/payments/captures?intentId=${id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(caps.body.total).toBe(1);
    });

    it('rejects capturing a CREATED intent (invalid transition)', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      await request(app.getHttpServer())
        .post(`/payments/intents/${intent.body.id}/capture`)
        .set(auth(managerToken))
        .send({})
        .expect(409);
    });

    it('rejects re-authorizing a CAPTURED (terminal) intent', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/authorize`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/capture`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/authorize`)
        .set(auth(managerToken))
        .send({})
        .expect(409);
    });

    it('a payment failure marks the order PAYMENT_FAILED, never PAID', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 400,
        currencyCode: 'SAR',
        orderId: 'order-a2',
      }).expect(201);
      await request(app.getHttpServer())
        .post(`/payments/intents/${intent.body.id}/fail`)
        .set(auth(managerToken))
        .send({ reason: 'card declined (simulated)' })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('FAILED'));
      expect(orderPaymentStatus('order-a2')).toBe('PAYMENT_FAILED');
    });

    it('rejects a fail reason carrying a raw card number', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      await request(app.getHttpServer())
        .post(`/payments/intents/${intent.body.id}/fail`)
        .set(auth(managerToken))
        .send({ reason: `declined ${TEST_PAN}` })
        .expect(400);
    });
  });

  describe('provider events (ingestion foundation)', () => {
    it('records a normalized event and deduplicates a re-delivery', async () => {
      const first = await request(app.getHttpServer())
        .post('/payment-events/simulate')
        .set(auth(managerToken))
        .send({
          provider: 'SIMULATED',
          providerEventId: 'evt-100',
          eventType: 'CAPTURE_SUCCEEDED',
        })
        .expect(201);
      expect(first.body.status).toBe('RECEIVED');
      const second = await request(app.getHttpServer())
        .post('/payment-events/simulate')
        .set(auth(managerToken))
        .send({
          provider: 'SIMULATED',
          providerEventId: 'evt-100',
          eventType: 'CAPTURE_SUCCEEDED',
        })
        .expect(201);
      expect(second.body.id).toBe(first.body.id);
      const list = await request(app.getHttpServer())
        .get('/payment-events?provider=SIMULATED')
        .set(auth(managerToken))
        .expect(200);
      expect(
        list.body.items.filter((e: { providerEventId: string }) => e.providerEventId === 'evt-100')
          .length,
      ).toBe(1);
    });

    it('records an UNKNOWN event as IGNORED', async () => {
      const res = await request(app.getHttpServer())
        .post('/payment-events/simulate')
        .set(auth(managerToken))
        .send({
          provider: 'SIMULATED',
          providerEventId: 'evt-unknown-1',
          eventType: 'UNKNOWN',
        })
        .expect(201);
      expect(res.body.status).toBe('IGNORED');
    });

    it('rejects a providerEventId carrying a secret token', async () => {
      await request(app.getHttpServer())
        .post('/payment-events/simulate')
        .set(auth(managerToken))
        .send({
          provider: 'SIMULATED',
          providerEventId: TEST_SECRET,
          eventType: 'CAPTURE_SUCCEEDED',
        })
        .expect(400);
    });
  });

  describe('reconciliation foundation', () => {
    it('marks a record RECONCILED, then rejects mutating the terminal record', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 800,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/authorize`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/capture`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      const list = await request(app.getHttpServer())
        .get(`/reconciliation/records?intentId=${id}`)
        .set(auth(managerToken))
        .expect(200);
      const recordId = list.body.items[0].id;

      await request(app.getHttpServer())
        .patch(`/reconciliation/records/${recordId}`)
        .set(auth(managerToken))
        .send({ status: 'RECONCILED', reportedAmountMinor: 800 })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('RECONCILED'));

      await request(app.getHttpServer())
        .patch(`/reconciliation/records/${recordId}`)
        .set(auth(managerToken))
        .send({ status: 'MISMATCH' })
        .expect(409);
    });

    it('rejects a reconciliation note carrying credentials', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 800,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/authorize`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`/payments/intents/${id}/capture`)
        .set(auth(managerToken))
        .send({})
        .expect(200);
      const list = await request(app.getHttpServer())
        .get(`/reconciliation/records?intentId=${id}`)
        .set(auth(managerToken))
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/reconciliation/records/${list.body.items[0].id}`)
        .set(auth(managerToken))
        .send({ status: 'MATCHED', notes: `token=${TEST_SECRET}` })
        .expect(400);
    });
  });
});
