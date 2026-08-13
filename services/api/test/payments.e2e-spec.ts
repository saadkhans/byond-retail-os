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

  // Full PaymentIntent row shape with overrides — keeps fixtures terse.
  const intentRow = (overrides: Partial<Row> & { id: string; tenantId: string }): Row =>
    ({
      orderId: null,
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
      ...overrides,
    }) as Row;

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
      // Session-linked projection (finding 1): an order generated from a
      // checkout session, to be bound by a session-only intent.
      {
        id: 'order-a3',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000003',
        checkoutSessionId: 'sess-a3',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Already-paid guard (finding 4): two intents target this order.
      {
        id: 'order-a5',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000005',
        checkoutSessionId: 'sess-a5',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Cancelled-order guard (finding 7): payments must not project onto it.
      {
        id: 'order-cx',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000009',
        checkoutSessionId: 'sess-cx',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CANCELLED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Already-PAID order (P2-D / capture guard): a pre-authorized intent
      // linked to it must not be captured or produce new holds.
      {
        id: 'order-paid',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000010',
        checkoutSessionId: 'sess-paid',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        paidAt: new Date('2026-07-12T01:00:00Z'),
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Sibling-hold guard (finding 4): two intents authorize this UNPAID
      // order; capturing one must void the other's hold.
      {
        id: 'order-sib',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000011',
        checkoutSessionId: 'sess-sib',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Bind target (finding 5): a standalone captured intent binds here.
      {
        id: 'order-bind',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000012',
        checkoutSessionId: 'sess-bind',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Two-authorized-intents order (finding 8): fail one, stays AUTHORIZED.
      {
        id: 'order-multi',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000013',
        checkoutSessionId: 'sess-multi',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Session-linked siblings order (finding 4).
      {
        id: 'order-ssib',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000014',
        checkoutSessionId: 'sess-ssib',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Bind-voids-sibling order (finding 5): has a pre-authorized sibling.
      {
        id: 'order-bindsib',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000015',
        checkoutSessionId: 'sess-bindsib',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'AUTHORIZED',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
      // Fresh UNPAID order for the rejected-bind retry (finding 1).
      {
        id: 'order-rb',
        tenantId: 'tenant-a',
        orderNumber: 'ORD-000016',
        checkoutSessionId: 'sess-rb',
        locationId: 'loc-a1',
        unitId: 'unit-a1',
        status: 'CONFIRMED',
        paymentStatus: 'UNPAID',
        paidAt: null,
        placedAt: new Date('2026-07-12T00:00:00Z'),
      },
    ] as Row[],
    sessions: [
      { id: 'sess-a1', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-a2', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-a3', tenantId: 'tenant-a', status: 'COMPLETED' },
      // sess-a4 has NO generated order yet (projection safely no-ops).
      { id: 'sess-a4', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-a5', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-cx', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-paid', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-sib', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-bind', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-multi', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-ssib', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-bindsib', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-rb', tenantId: 'tenant-a', status: 'COMPLETED' },
      { id: 'sess-b', tenantId: 'tenant-b', status: 'COMPLETED' },
    ] as Row[],
    intents: [
      intentRow({ id: 'pi-b', tenantId: 'tenant-b', orderId: 'order-b' }),
      // Pre-AUTHORIZED intent linked to the CANCELLED order (finding 7): a
      // capture attempt must be rejected and must not mark the order PAID.
      intentRow({
        id: 'pi-cx-auth',
        tenantId: 'tenant-a',
        orderId: 'order-cx',
        status: 'AUTHORIZED',
        amountMinor: 500,
        authorizedAt: new Date('2026-07-12T00:00:00Z'),
      }),
      // Pre-AUTHORIZED intent linked to an already-PAID order (P2-D / capture
      // guard): capture must be rejected and write no rows.
      intentRow({
        id: 'pi-paid-auth',
        tenantId: 'tenant-a',
        orderId: 'order-paid',
        status: 'AUTHORIZED',
        amountMinor: 500,
        authorizedAt: new Date('2026-07-12T00:00:00Z'),
      }),
      // Pre-AUTHORIZED sibling on order-bindsib (finding 5): a standalone
      // captured intent bound to that order must void THIS hold.
      intentRow({
        id: 'pi-bindsib-auth',
        tenantId: 'tenant-a',
        orderId: 'order-bindsib',
        status: 'AUTHORIZED',
        amountMinor: 500,
        authorizedAt: new Date('2026-07-12T00:00:00Z'),
      }),
    ] as Row[],
    authorizations: [
      {
        id: 'auth-bindsib',
        tenantId: 'tenant-a',
        intentId: 'pi-bindsib-auth',
        status: 'AUTHORIZED',
        amountMinor: 500,
        providerRef: null,
        authorizedAt: new Date('2026-07-12T00:00:00Z'),
        expiresAt: null,
        voidedAt: null,
        idempotencyKey: null,
        createdById: null,
        createdAt: new Date('2026-07-12T00:00:00Z'),
        updatedAt: new Date('2026-07-12T00:00:00Z'),
      },
    ] as Row[],
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
    tenant: {
      // Platform-sandbox lookup (AuthGuard): no sandbox tenant in these
      // fixtures, so platform users keep a NULL tenant context and every
      // tenant-scoped route stays 403 for them.
      findFirst: async () => null,
    },
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
        store.orders.find((o) =>
          scalarMatch(o, where, ['id', 'tenantId', 'checkoutSessionId']),
        ) ?? null,
      findFirstOrThrow: async ({ where }: { where: Where }) => {
        const row = store.orders.find((o) =>
          scalarMatch(o, where, ['id', 'tenantId']),
        );
        if (!row) {
          throw new Error('Order not found');
        }
        return { ...row };
      },
      // Honors the conditional guards `status: { not }` / `paymentStatus:
      // { not }` the projection uses to keep a PAID/CANCELLED order intact.
      updateMany: async ({ where, data }: { where: Where; data: Where }) => {
        const matchNot = (field: string, value: unknown) =>
          where[field] === undefined ||
          (typeof where[field] === 'object' && where[field].not !== undefined
            ? value !== where[field].not
            : value === where[field]);
        const row = store.orders.find(
          (o) =>
            o.id === where.id &&
            o.tenantId === where.tenantId &&
            matchNot('status', o.status) &&
            matchNot('paymentStatus', o.paymentStatus),
        );
        if (!row) {
          return { count: 0 };
        }
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return { count: 1 };
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
          .filter(
            (r) =>
              scalarMatch(r, where, [
                'tenantId',
                'status',
                'provider',
                'orderId',
                'checkoutSessionId',
              ]) &&
              // Honors `id: { not }` (sibling-hold lookup excludes the
              // capturing intent).
              (where.id?.not === undefined || r.id !== where.id.not) &&
              // Honors `OR: [{ orderId }, { checkoutSessionId }]` — the
              // order-linked-intent lookup (recompute / sibling holds).
              (where.OR === undefined ||
                where.OR.some(
                  (clause: Where) =>
                    (clause.orderId === undefined ||
                      r.orderId === clause.orderId) &&
                    (clause.checkoutSessionId === undefined ||
                      r.checkoutSessionId === clause.checkoutSessionId),
                )),
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
        // Supports both `{ id }` and the tenant-scoped composite
        // `{ id_tenantId: { id, tenantId } }` unique the repository now uses.
        const wid = where.id_tenantId?.id ?? where.id;
        const wtid = where.id_tenantId?.tenantId;
        const row = store.intents.find(
          (r) => r.id === wid && (wtid === undefined || r.tenantId === wtid),
        )!;
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
          const intentMatch =
            where.intentId === undefined
              ? true
              : typeof where.intentId === 'object' && where.intentId.in
                ? where.intentId.in.includes(row.intentId)
                : row.intentId === where.intentId;
          const idMatch =
            where.id === undefined
              ? true
              : typeof where.id === 'object' && where.id.in
                ? where.id.in.includes(row.id)
                : row.id === where.id;
          if (
            intentMatch &&
            idMatch &&
            scalarMatch(row, where, ['tenantId', 'status'])
          ) {
            Object.assign(row, stripUndefined(data));
            count += 1;
          }
        }
        return { count };
      },
      count: async ({ where }: { where: Where }) =>
        store.authorizations.filter((row) => {
          const intentMatch =
            where.intentId === undefined
              ? true
              : typeof where.intentId === 'object' && where.intentId.in
                ? where.intentId.in.includes(row.intentId)
                : row.intentId === where.intentId;
          return intentMatch && scalarMatch(row, where, ['tenantId', 'status']);
        }).length,
      findMany: async ({ where }: { where: Where }) =>
        store.authorizations
          .filter((row) => {
            const intentMatch =
              where.intentId === undefined
                ? true
                : typeof where.intentId === 'object' && where.intentId.in
                  ? where.intentId.in.includes(row.intentId)
                  : row.intentId === where.intentId;
            return (
              intentMatch && scalarMatch(row, where, ['tenantId', 'status'])
            );
          })
          .map((row) => ({ ...row })),
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
      updateMany: async ({ where, data }: { where: Where; data: Where }) => {
        // Honors the conditional guard `status: { not: RECONCILED }` the
        // repository uses to keep RECONCILED terminal under concurrency.
        const notStatus =
          typeof where.status === 'object' ? where.status.not : undefined;
        const row = store.reconciliations.find(
          (r) =>
            r.id === where.id &&
            r.tenantId === where.tenantId &&
            (notStatus === undefined || r.status !== notStatus),
        );
        if (!row) {
          return { count: 0 };
        }
        Object.assign(row, stripUndefined(data), { updatedAt: new Date() });
        return { count: 1 };
      },
      findFirstOrThrow: async ({
        where,
        include,
      }: {
        where: Where;
        include?: Where;
      }) => {
        const row = store.reconciliations.find((r) =>
          scalarMatch(r, where, ['id', 'tenantId']),
        );
        if (!row) {
          throw new Error('PaymentReconciliationRecord not found');
        }
        return include ? reconView(row) : { ...row };
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

  // Phase 6 policy: financial transitions require a bound order, so tests that
  // exercise the lifecycle mint a fresh CONFIRMED/UNPAID order on demand.
  let fixtureSeq = 0;
  const makeOrder = (): string => {
    fixtureSeq += 1;
    const sessionId = `sess-fx-${fixtureSeq}`;
    const orderId = `order-fx-${fixtureSeq}`;
    store.sessions.push({
      id: sessionId,
      tenantId: 'tenant-a',
      status: 'COMPLETED',
    } as Row);
    store.orders.push({
      id: orderId,
      tenantId: 'tenant-a',
      orderNumber: `ORD-FX${fixtureSeq}`,
      checkoutSessionId: sessionId,
      locationId: 'loc-a1',
      unitId: 'unit-a1',
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      paidAt: null,
      placedAt: new Date('2026-07-12T00:00:00Z'),
    } as Row);
    return orderId;
  };

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

    it('rejects bare CVV/PIN-shaped values in metadata, but allows last4 (finding 10)', async () => {
      // 3- or 4-digit bare values (CVV/PIN shape) are rejected in metadata.
      for (const field of [
        { instrumentBrand: '123' },
        { instrumentWallet: '1234' },
        { description: '123' },
        { description: '1 2 3 4' },
      ]) {
        await createIntent(managerToken, {
          amountMinor: 500,
          currencyCode: 'SAR',
          ...field,
        }).expect(400);
      }
      // Exactly four digits is allowed ONLY in instrumentLast4.
      const ok = await createIntent(managerToken, {
        amountMinor: 500,
        currencyCode: 'SAR',
        instrumentLast4: '4242',
        instrumentBrand: 'VISA',
        instrumentWallet: 'APPLE_PAY',
        description: 'Walk-out purchase',
      }).expect(201);
      expect(ok.body.instrumentLast4).toBe('4242');
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
        orderId: makeOrder(),
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
        orderId: makeOrder(),
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
        orderId: makeOrder(),
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
        orderId: makeOrder(),
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

  // ---- Codex hardening pass ------------------------------------------------

  const authorizeThen = (id: string, path: string, body = {}) =>
    request(app.getHttpServer())
      .post(`/payments/intents/${id}/${path}`)
      .set(auth(managerToken))
      .send(body);

  describe('session-linked order projection (finding 1)', () => {
    it('capturing a session-only intent marks the generated order PAID', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 1200,
        currencyCode: 'SAR',
        checkoutSessionId: 'sess-a3',
      }).expect(201);
      expect(intent.body.orderId).toBeNull();
      const id = intent.body.id;
      await authorizeThen(id, 'authorize').expect(200);
      await authorizeThen(id, 'capture', { idempotencyKey: 'f1-cap' }).expect(
        200,
      );
      expect(orderPaymentStatus('order-a3')).toBe('PAID');
      expect(store.orders.find((o) => o.id === 'order-a3')?.paidAt).not.toBeNull();
    });

    it('rejects authorize AND capture for a session-linked intent before its order exists (finding 3)', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        checkoutSessionId: 'sess-a4',
      }).expect(201);
      const id = intent.body.id;
      // sess-a4 has no generated order yet. A pre-order authorization/capture/
      // fail would be lost when the order is later created UNPAID, so all are
      // rejected (walk-out pre-auth uses a STANDALONE intent + bind instead).
      await authorizeThen(id, 'authorize').expect(409);
      await authorizeThen(id, 'capture').expect(409);
      await authorizeThen(id, 'fail').expect(409); // finding 3
      const caps = await request(app.getHttpServer())
        .get(`/payments/captures?intentId=${id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(caps.body.total).toBe(0);
    });

    it('rejects linking another tenant’s checkout session (cross-tenant)', async () => {
      await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        checkoutSessionId: 'sess-b',
      }).expect(400);
    });
  });

  describe('already-paid order guard (findings 4 & P2-D)', () => {
    it('pays the order, replays the same capture, and blocks a second intent', async () => {
      const first = await createIntent(managerToken, {
        amountMinor: 700,
        currencyCode: 'SAR',
        orderId: 'order-a5',
      }).expect(201);
      await authorizeThen(first.body.id, 'authorize').expect(200);
      await authorizeThen(first.body.id, 'capture', {
        idempotencyKey: 'f4-cap-1',
      }).expect(200);
      expect(orderPaymentStatus('order-a5')).toBe('PAID');

      // Idempotent replay of the SAME capture still works.
      await authorizeThen(first.body.id, 'capture', {
        idempotencyKey: 'f4-cap-1',
      })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('CAPTURED'));

      // A SECOND intent for the same order cannot even be AUTHORIZED once the
      // order is PAID (P2-D) — no new simulated hold can accumulate.
      const second = await createIntent(managerToken, {
        amountMinor: 700,
        currencyCode: 'SAR',
        orderId: 'order-a5',
      }).expect(201);
      await authorizeThen(second.body.id, 'authorize').expect(409);
    });

    it('rejects capturing a pre-authorized intent whose order is already paid; no rows written', async () => {
      await authorizeThen('pi-paid-auth', 'capture').expect(409);
      const caps = await request(app.getHttpServer())
        .get('/payments/captures?intentId=pi-paid-auth')
        .set(auth(managerToken))
        .expect(200);
      expect(caps.body.total).toBe(0);
      const recon = await request(app.getHttpServer())
        .get('/reconciliation/records?intentId=pi-paid-auth')
        .set(auth(managerToken))
        .expect(200);
      expect(recon.body.total).toBe(0);
      expect(orderPaymentStatus('order-paid')).toBe('PAID');
    });
  });

  describe('failing an authorized intent clears its holds (finding 5)', () => {
    it('voids active authorization rows when the intent is failed', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 250,
        currencyCode: 'SAR',
        orderId: makeOrder(),
      }).expect(201);
      const id = intent.body.id;
      await authorizeThen(id, 'authorize').expect(200);
      await authorizeThen(id, 'fail', { reason: 'timeout (simulated)' })
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('FAILED'));
      const detail = await request(app.getHttpServer())
        .get(`/payments/intents/${id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(detail.body.authorizations.length).toBeGreaterThan(0);
      expect(
        detail.body.authorizations.every(
          (a: { status: string }) => a.status === 'VOIDED',
        ),
      ).toBe(true);
    });
  });

  describe('cancelled-order guard (finding 7)', () => {
    it('rejects capturing an intent linked to a cancelled order; order stays UNPAID', async () => {
      await authorizeThen('pi-cx-auth', 'capture').expect(409);
      expect(orderPaymentStatus('order-cx')).toBe('UNPAID');
    });

    it('rejects authorizing an intent linked to a cancelled order', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        orderId: 'order-cx',
      }).expect(201);
      await authorizeThen(intent.body.id, 'authorize').expect(409);
    });

    it('failing an intent does not project PAYMENT_FAILED onto a cancelled order', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        orderId: 'order-cx',
      }).expect(201);
      await authorizeThen(intent.body.id, 'fail')
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('FAILED'));
      expect(orderPaymentStatus('order-cx')).toBe('UNPAID');
    });
  });

  describe('provider-mismatched events (finding 8)', () => {
    const simulateEvent = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/payment-events/simulate')
        .set(auth(managerToken))
        .send(body);

    it('accepts a matching-provider event and rejects a mismatched one', async () => {
      const manual = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        provider: 'MANUAL',
      }).expect(201);
      // Matching provider (MANUAL event → MANUAL intent) is accepted.
      await simulateEvent({
        provider: 'MANUAL',
        providerEventId: 'evt-manual-1',
        eventType: 'CAPTURE_SUCCEEDED',
        intentId: manual.body.id,
      }).expect(201);
      // Mismatched provider (SIMULATED event → MANUAL intent) is rejected.
      await simulateEvent({
        provider: 'SIMULATED',
        providerEventId: 'evt-manual-2',
        eventType: 'CAPTURE_SUCCEEDED',
        intentId: manual.body.id,
      }).expect(409);
    });

    it('still rejects an event for another tenant’s intent', async () => {
      await simulateEvent({
        provider: 'SIMULATED',
        providerEventId: 'evt-xtenant',
        eventType: 'CAPTURE_SUCCEEDED',
        intentId: 'pi-b',
      }).expect(400);
    });
  });

  describe('event idempotency-key conflicts (finding 3)', () => {
    const simulateEvent = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/payment-events/simulate')
        .set(auth(managerToken))
        .send(body);

    it('replays same event, but 409s a key reused for a different event', async () => {
      const first = await simulateEvent({
        provider: 'SIMULATED',
        providerEventId: 'evt-k1',
        eventType: 'CAPTURE_SUCCEEDED',
        idempotencyKey: 'ikey-1',
      }).expect(201);
      // Same providerEventId + same key → dedupe replay (same record).
      const replay = await simulateEvent({
        provider: 'SIMULATED',
        providerEventId: 'evt-k1',
        eventType: 'CAPTURE_SUCCEEDED',
        idempotencyKey: 'ikey-1',
      }).expect(201);
      expect(replay.body.id).toBe(first.body.id);
      // DIFFERENT providerEventId reusing the key → controlled 409, not a 500.
      await simulateEvent({
        provider: 'SIMULATED',
        providerEventId: 'evt-k2',
        eventType: 'CAPTURE_SUCCEEDED',
        idempotencyKey: 'ikey-1',
      }).expect(409);
    });
  });

  describe('sibling authorization holds released after capture (finding 4)', () => {
    it('voids a sibling intent’s active hold when the order is paid', async () => {
      const first = await createIntent(managerToken, {
        amountMinor: 600,
        currencyCode: 'SAR',
        orderId: 'order-sib',
      }).expect(201);
      const second = await createIntent(managerToken, {
        amountMinor: 600,
        currencyCode: 'SAR',
        orderId: 'order-sib',
      }).expect(201);
      // Both authorized while the order is still UNPAID.
      await authorizeThen(first.body.id, 'authorize').expect(200);
      await authorizeThen(second.body.id, 'authorize').expect(200);
      // Capture the first → order PAID.
      await authorizeThen(first.body.id, 'capture').expect(200);
      expect(orderPaymentStatus('order-sib')).toBe('PAID');
      // The sibling's hold is now voided, and its capture is rejected.
      const siblingDetail = await request(app.getHttpServer())
        .get(`/payments/intents/${second.body.id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(
        siblingDetail.body.authorizations.every(
          (a: { status: string }) => a.status === 'VOIDED',
        ),
      ).toBe(true);
      await authorizeThen(second.body.id, 'capture').expect(409);
    });
  });

  describe('post-create intent bind (finding 5)', () => {
    const bind = (id: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch(`/payments/intents/${id}/bind`)
        .set(auth(managerToken))
        .send(body);

    it('binds a standalone captured intent to an order and marks it PAID', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 900,
        currencyCode: 'SAR',
      }).expect(201);
      expect(intent.body.orderId).toBeNull();
      const id = intent.body.id;
      // Phase 6 policy: a standalone intent CANNOT transition financially.
      await authorizeThen(id, 'authorize').expect(409);
      await authorizeThen(id, 'capture').expect(409);
      await authorizeThen(id, 'fail').expect(409);
      await authorizeThen(id, 'cancel').expect(409);
      // Bind first (same idempotency key across attempts), THEN transition.
      const bound = await bind(id, {
        orderId: 'order-bind',
        idempotencyKey: 'bind-key-1',
      }).expect(200);
      expect(bound.body.orderId).toBe('order-bind');
      await authorizeThen(id, 'authorize').expect(200);
      await authorizeThen(id, 'capture')
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('CAPTURED'));
      expect(orderPaymentStatus('order-bind')).toBe('PAID');
      // Re-binding to the SAME order replays (same key or not).
      await bind(id, {
        orderId: 'order-bind',
        idempotencyKey: 'bind-key-1',
      }).expect(200);
      // Re-binding to a DIFFERENT order is a conflict.
      await bind(id, { orderId: 'order-a2' }).expect(409);
    });

    it('binds an unlinked intent to a checkout session (no projection needed)', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      const bound = await bind(intent.body.id, {
        checkoutSessionId: 'sess-a4',
      }).expect(200);
      expect(bound.body.checkoutSessionId).toBe('sess-a4');
    });

    it('rejects binding with no target', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      await bind(intent.body.id, {}).expect(400);
    });

    it('rejects binding to another tenant’s order (cross-tenant)', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      await bind(intent.body.id, { orderId: 'order-b' }).expect(400);
    });

    it('rejects binding any new intent to an already-paid order', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      await bind(intent.body.id, { orderId: 'order-paid' }).expect(409);
    });

    it('bind by checkoutSessionId resolves the session’s existing order', async () => {
      const orderId = makeOrder();
      const sessionId = store.orders.find((o) => o.id === orderId)!
        .checkoutSessionId as string;
      const intent = await createIntent(managerToken, {
        amountMinor: 150,
        currencyCode: 'SAR',
      }).expect(201);
      const bound = await bind(intent.body.id, {
        checkoutSessionId: sessionId,
      }).expect(200);
      // The session's generated order was resolved and bound too.
      expect(bound.body.orderId).toBe(orderId);
      expect(bound.body.checkoutSessionId).toBe(sessionId);
      await authorizeThen(intent.body.id, 'authorize').expect(200);
    });
  });

  describe('reconciliation audit snapshot (finding 2)', () => {
    it('records the ACTUAL previous state, not a stale one, across updates', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 800,
        currencyCode: 'SAR',
        orderId: makeOrder(),
      }).expect(201);
      const id = intent.body.id;
      await authorizeThen(id, 'authorize').expect(200);
      await authorizeThen(id, 'capture').expect(200);
      const list = await request(app.getHttpServer())
        .get(`/reconciliation/records?intentId=${id}`)
        .set(auth(managerToken))
        .expect(200);
      const recordId = list.body.items[0].id as string;

      auditCreateSpy.mockClear();
      await request(app.getHttpServer())
        .patch(`/reconciliation/records/${recordId}`)
        .set(auth(managerToken))
        .send({ status: 'MATCHED' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/reconciliation/records/${recordId}`)
        .set(auth(managerToken))
        .send({ status: 'RECONCILED' })
        .expect(200);

      const reconcileAudits = auditCreateSpy.mock.calls
        .map((call) => call[0].data)
        .filter(
          (data: { action: string; entityId: string }) =>
            data.action === 'RECONCILE' && data.entityId === recordId,
        );
      expect(reconcileAudits).toHaveLength(2);
      // PENDING -> MATCHED
      expect(reconcileAudits[0].before.status).toBe('PENDING');
      expect(reconcileAudits[0].after.status).toBe('MATCHED');
      // MATCHED -> RECONCILED (before is MATCHED, NOT a stale PENDING)
      expect(reconcileAudits[1].before.status).toBe('MATCHED');
      expect(reconcileAudits[1].after.status).toBe('RECONCILED');
    });
  });

  const bindReq = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/payments/intents/${id}/bind`)
      .set(auth(managerToken))
      .send(body);
  const intentDetail = (id: string) =>
    request(app.getHttpServer())
      .get(`/payments/intents/${id}`)
      .set(auth(managerToken));

  describe('rejected binds roll back without mutation', () => {
    it('rejects binding to a paid order; intent unchanged, no audit, retry works', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      auditCreateSpy.mockClear();
      await bindReq(id, { orderId: 'order-paid' }).expect(409);
      // Intent NOT bound, and NO audit entry recorded for the failed bind.
      const detail = await intentDetail(id).expect(200);
      expect(detail.body.orderId).toBeNull();
      expect(
        auditCreateSpy.mock.calls.some(
          (call) => call[0].data.entityId === id,
        ),
      ).toBe(false);
      // A retry to a VALID order still works (not falsely idempotent), and
      // the full flow then pays that order.
      await bindReq(id, { orderId: 'order-rb' }).expect(200);
      await authorizeThen(id, 'authorize').expect(200);
      await authorizeThen(id, 'capture').expect(200);
      expect(orderPaymentStatus('order-rb')).toBe('PAID');
    });

    it('rejects binding to a cancelled order; intent unchanged, no audit', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      auditCreateSpy.mockClear();
      await bindReq(id, { orderId: 'order-cx' }).expect(409);
      const detail = await intentDetail(id).expect(200);
      expect(detail.body.orderId).toBeNull();
      expect(
        auditCreateSpy.mock.calls.some(
          (call) => call[0].data.entityId === id,
        ),
      ).toBe(false);
    });
  });

  describe('bind validates the intent’s existing session (finding 2)', () => {
    it('rejects binding an order whose session differs from the intent’s session', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        checkoutSessionId: 'sess-a4',
      }).expect(201);
      // order-bind belongs to sess-bind, not sess-a4 → mismatch.
      await bindReq(intent.body.id, { orderId: 'order-bind' }).expect(400);
    });

    it('allows binding an order from the intent’s own session', async () => {
      const orderId = makeOrder();
      const sessionId = store.orders.find((o) => o.id === orderId)!
        .checkoutSessionId as string;
      const intent = await createIntent(managerToken, {
        amountMinor: 100,
        currencyCode: 'SAR',
        checkoutSessionId: sessionId,
      }).expect(201);
      await bindReq(intent.body.id, { orderId }).expect(200);
    });
  });

  describe('capture after bind voids sibling holds (with audit)', () => {
    it('releases the pre-authorized sibling when a bound intent captures', async () => {
      const intent = await createIntent(managerToken, {
        amountMinor: 500,
        currencyCode: 'SAR',
      }).expect(201);
      const id = intent.body.id;
      // Bind first (order-bindsib is AUTHORIZED — not PAID — so bind is legal),
      // then authorize and capture through the normal lifecycle.
      await bindReq(id, { orderId: 'order-bindsib' }).expect(200);
      await authorizeThen(id, 'authorize').expect(200);
      auditCreateSpy.mockClear();
      await authorizeThen(id, 'capture').expect(200);
      expect(orderPaymentStatus('order-bindsib')).toBe('PAID');
      // The fixture sibling pi-bindsib-auth's hold is now voided…
      const siblingDetail = await intentDetail('pi-bindsib-auth').expect(200);
      expect(
        siblingDetail.body.authorizations.every(
          (a: { status: string }) => a.status === 'VOIDED',
        ),
      ).toBe(true);
      // …and the bulk release was AUDITED.
      expect(
        auditCreateSpy.mock.calls.some(
          (call) =>
            call[0].data.action === 'VOID' &&
            call[0].data.entityType === 'PaymentAuthorization',
        ),
      ).toBe(true);
      await authorizeThen('pi-bindsib-auth', 'capture').expect(409);
    });
  });

  describe('session-linked siblings are released after capture (finding 4)', () => {
    it('voids a session-only sibling’s hold when one captures', async () => {
      const first = await createIntent(managerToken, {
        amountMinor: 400,
        currencyCode: 'SAR',
        checkoutSessionId: 'sess-ssib',
      }).expect(201);
      const second = await createIntent(managerToken, {
        amountMinor: 400,
        currencyCode: 'SAR',
        checkoutSessionId: 'sess-ssib',
      }).expect(201);
      // order-ssib exists (its session is sess-ssib), so authorize resolves it.
      await authorizeThen(first.body.id, 'authorize').expect(200);
      await authorizeThen(second.body.id, 'authorize').expect(200);
      await authorizeThen(first.body.id, 'capture').expect(200);
      expect(orderPaymentStatus('order-ssib')).toBe('PAID');
      const siblingDetail = await intentDetail(second.body.id).expect(200);
      expect(
        siblingDetail.body.authorizations.every(
          (a: { status: string }) => a.status === 'VOIDED',
        ),
      ).toBe(true);
    });
  });

  describe('order projection preserves AUTHORIZED while a sibling hold remains (finding 8)', () => {
    it('failing one of two authorized intents keeps the order AUTHORIZED', async () => {
      const first = await createIntent(managerToken, {
        amountMinor: 300,
        currencyCode: 'SAR',
        orderId: 'order-multi',
      }).expect(201);
      const second = await createIntent(managerToken, {
        amountMinor: 300,
        currencyCode: 'SAR',
        orderId: 'order-multi',
      }).expect(201);
      await authorizeThen(first.body.id, 'authorize').expect(200);
      await authorizeThen(second.body.id, 'authorize').expect(200);
      expect(orderPaymentStatus('order-multi')).toBe('AUTHORIZED');
      // Fail the first → the second still holds → order STAYS AUTHORIZED.
      await authorizeThen(first.body.id, 'fail').expect(200);
      expect(orderPaymentStatus('order-multi')).toBe('AUTHORIZED');
      // Fail the second → no active hold, no capture → PAYMENT_FAILED.
      await authorizeThen(second.body.id, 'fail').expect(200);
      expect(orderPaymentStatus('order-multi')).toBe('PAYMENT_FAILED');
    });
  });
});
