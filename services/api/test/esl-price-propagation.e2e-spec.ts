import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PriceActivationHub } from '../src/pricing/price-activation.hub';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The second end-to-end journey TESTING.md requires: **an admin price change
 * propagates to a label.**
 *
 * This drives the REAL stack over HTTP — the real AppModule, the real guards,
 * the real PricingService, the real PriceActivationHub subscription made at
 * bootstrap, the real EslService, the real vendor registry and the real
 * simulated adapter. Only PrismaService is replaced, by the deterministic
 * in-memory fixture below (same pattern as the other e2e suites here: no live
 * database, so the journey is provable in CI).
 *
 * If anything in that chain silently stops labels following prices, this
 * suite fails — which is the entire point of having it.
 */

const PASSWORDS = {
  manager: 'manager-local-password',
  viewer: 'viewer-local-password',
};

/** Loosely-typed Prisma `where`/`data`/`select` shapes, as the stub sees them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe('Admin price change → ESL label (e2e, no live database)', () => {
  let app: INestApplication;
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

  const NOW = new Date('2026-09-16T10:00:00.000Z');

  const users = [
    {
      id: 'manager-a',
      tenantId: 'tenant-a' as string | null,
      userType: 'TENANT',
      email: 'manager@tenant-a.example',
      firstName: 'Mana',
      lastName: 'Ger',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.manager, 4),
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'viewer-a',
      tenantId: 'tenant-a' as string | null,
      userType: 'TENANT',
      email: 'viewer@tenant-a.example',
      firstName: 'View',
      lastName: 'Er',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.viewer, 4),
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'manager-b',
      tenantId: 'tenant-b' as string | null,
      userType: 'TENANT',
      email: 'manager@tenant-b.example',
      firstName: 'Bee',
      lastName: 'Manager',
      status: 'ACTIVE',
      passwordHash: hashSync(PASSWORDS.manager, 4),
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  const grants: Record<string, { tenantId: string | null; codes: string[] }> = {
    'manager-a': {
      tenantId: 'tenant-a',
      codes: [
        'price-book:read',
        'price-book:manage',
        'price:read',
        'esl-gateway:read',
        'esl-gateway:manage',
        'esl-label:read',
        'esl-label:manage',
        'esl-job:read',
        'esl-job:process',
      ],
    },
    // Deliberately read-only: proves a reader cannot rebind hardware or drive
    // the queue, which is the whole reason the permissions are split.
    'viewer-a': {
      tenantId: 'tenant-a',
      codes: ['esl-gateway:read', 'esl-label:read', 'esl-job:read'],
    },
    'manager-b': {
      tenantId: 'tenant-b',
      codes: ['esl-gateway:read', 'esl-label:read', 'esl-label:manage'],
    },
  };

  const platformModules = [
    { id: 'module-core', code: 'core', name: 'Core', isActive: true },
    { id: 'module-pricing', code: 'pricing', name: 'Pricing', isActive: true },
    { id: 'module-esl', code: 'esl', name: 'Shelf labels', isActive: true },
  ];
  const tenantModules = [
    {
      id: 'tm-a-pricing',
      tenantId: 'tenant-a',
      moduleId: 'module-pricing',
      status: 'ENABLED',
    },
    { id: 'tm-a-esl', tenantId: 'tenant-a', moduleId: 'module-esl', status: 'ENABLED' },
    { id: 'tm-b-esl', tenantId: 'tenant-b', moduleId: 'module-esl', status: 'ENABLED' },
  ];

  // ------------------------------------------------------------ fixtures

  const locations: Loose[] = [
    { id: 'loc-a1', tenantId: 'tenant-a', code: 'A1', name: 'Store A1' },
    { id: 'loc-b1', tenantId: 'tenant-b', code: 'B1', name: 'Store B1' },
  ];

  const products: Loose[] = [
    {
      id: 'prod-water',
      tenantId: 'tenant-a',
      sku: 'WATER-500',
      name: 'Drinking Water 500ml',
      status: 'ACTIVE',
    },
    {
      id: 'prod-cola',
      tenantId: 'tenant-a',
      sku: 'COLA-330',
      name: 'Cola 330ml',
      status: 'ACTIVE',
    },
    {
      id: 'prod-b',
      tenantId: 'tenant-b',
      sku: 'B-SKU-1',
      name: 'Tenant B Cola',
      status: 'ACTIVE',
    },
  ];

  const priceBooks: Loose[] = [
    {
      id: 'book-a',
      tenantId: 'tenant-a',
      code: 'RETAIL',
      name: 'Retail',
      currencyCode: 'AED',
      locationId: null,
      status: 'ACTIVE',
    },
  ];

  // v1 is live at 250; v2 is the draft the admin activates at 275.
  const priceBookVersions: Loose[] = [
    {
      id: 'ver-1',
      tenantId: 'tenant-a',
      priceBookId: 'book-a',
      versionNumber: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      effectiveTo: null,
      reason: 'INITIAL',
      note: null,
      createdById: 'manager-a',
      activatedById: 'manager-a',
      activatedAt: new Date('2026-09-01T00:00:00.000Z'),
      supersededByVersionId: null,
      rolledBackFromVersionId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'ver-2',
      tenantId: 'tenant-a',
      priceBookId: 'book-a',
      versionNumber: 2,
      status: 'DRAFT',
      effectiveFrom: new Date('2026-09-16T00:00:00.000Z'),
      effectiveTo: null,
      reason: 'PRICE_CHANGE',
      note: null,
      createdById: 'manager-a',
      activatedById: null,
      activatedAt: null,
      supersededByVersionId: null,
      rolledBackFromVersionId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  const priceBookEntries: Loose[] = [
    {
      id: 'entry-1',
      tenantId: 'tenant-a',
      versionId: 'ver-1',
      productId: 'prod-water',
      unitPriceMinor: 250,
      currencyCode: 'AED',
    },
    {
      id: 'entry-2',
      tenantId: 'tenant-a',
      versionId: 'ver-2',
      productId: 'prod-water',
      unitPriceMinor: 275,
      currencyCode: 'AED',
    },
  ];

  const eslGateways: Loose[] = [];
  const eslLabels: Loose[] = [];
  const eslUpdateJobs: Loose[] = [];
  const auditRows: Loose[] = [];

  // ------------------------------------------------------- stub helpers

  function stripUndefined(data: Loose): Loose {
    return Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );
  }

  /** Applies one Prisma `data` object, honouring `{ increment }`. */
  function applyData(row: Loose, data: Loose): void {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        row[key] = (row[key] as number) + (value.increment as number);
        continue;
      }
      row[key] = value;
    }
    row.updatedAt = new Date();
  }

  /**
   * The single `where` interpreter every ESL/pricing delegate below shares.
   * It covers exactly the operators this repo's repositories use: scalar
   * equality, `in`, `notIn`, `not`, `lt`, `lte`, `gt`, `OR`, and a one-level
   * relation filter (`gateway: { ... }`, `version: { ... }`).
   */
  function matches(row: Loose, where: Loose | undefined, resolve: Relations): boolean {
    if (!where) {
      return true;
    }
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) {
        continue;
      }
      if (key === 'OR') {
        if (
          !(condition as Loose[]).some((clause) => matches(row, clause, resolve))
        ) {
          return false;
        }
        continue;
      }
      const related = resolve[key]?.(row);
      if (related !== undefined) {
        if (related === null || !matches(related, condition as Loose, resolve)) {
          return false;
        }
        continue;
      }
      const value = row[key];
      if (condition === null) {
        if (value !== null && value !== undefined) {
          return false;
        }
        continue;
      }
      if (typeof condition === 'object' && !(condition instanceof Date)) {
        const clause = condition as Loose;
        if (clause.in !== undefined && !(clause.in as unknown[]).includes(value)) {
          return false;
        }
        if (
          clause.notIn !== undefined &&
          (clause.notIn as unknown[]).includes(value)
        ) {
          return false;
        }
        if (clause.not !== undefined && value === clause.not) {
          return false;
        }
        if (clause.lt !== undefined && !(asTime(value) < asTime(clause.lt))) {
          return false;
        }
        if (clause.lte !== undefined && !(asTime(value) <= asTime(clause.lte))) {
          return false;
        }
        if (clause.gt !== undefined && !(asTime(value) > asTime(clause.gt))) {
          return false;
        }
        continue;
      }
      if (value !== condition) {
        return false;
      }
    }
    return true;
  }

  type Relations = Record<string, ((row: Loose) => Loose | null) | undefined>;

  function asTime(value: unknown): number {
    return value instanceof Date ? value.getTime() : Number(value);
  }

  function sortRows(rows: Loose[], orderBy: Loose | Loose[] | undefined): Loose[] {
    if (!orderBy) {
      return rows;
    }
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((left, right) => {
      for (const clause of clauses) {
        const [key, direction] = Object.entries(clause)[0] as [string, string];
        const a = left[key];
        const b = right[key];
        if (a === b) {
          continue;
        }
        const less = asComparable(a) < asComparable(b) ? -1 : 1;
        return direction === 'desc' ? -less : less;
      }
      return 0;
    });
  }

  function asComparable(value: unknown): number | string {
    if (value instanceof Date) {
      return value.getTime();
    }
    if (value === null || value === undefined) {
      return '';
    }
    return value as number | string;
  }

  // ---------------------------------------------------- relation lookups

  const gatewayOf = (label: Loose) =>
    eslGateways.find((row) => row.id === label.gatewayId) ?? null;
  const versionOf = (entry: Loose) =>
    priceBookVersions.find((row) => row.id === entry.versionId) ?? null;
  const bookOf = (version: Loose) =>
    priceBooks.find((row) => row.id === version.priceBookId) ?? null;

  const labelRelations: Relations = { gateway: gatewayOf };
  const entryRelations: Relations = {
    version: (entry) => {
      const version = versionOf(entry);
      return version ? { ...version, priceBook: bookOf(version) } : null;
    },
    priceBook: (version) => bookOf(version),
  };

  // --------------------------------------------------------- projections

  function gatewayDetail(gateway: Loose): Loose {
    return {
      ...gateway,
      location:
        locations.find((row) => row.id === gateway.locationId) ?? null,
      _count: {
        labels: eslLabels.filter((row) => row.gatewayId === gateway.id).length,
      },
    };
  }

  function labelDetail(label: Loose): Loose {
    const gateway = gatewayOf(label);
    return {
      ...label,
      gateway: gateway
        ? {
            id: gateway.id,
            code: gateway.code,
            vendorCode: gateway.vendorCode,
            status: gateway.status,
          }
        : null,
      product: label.productId
        ? (() => {
            const product = products.find((row) => row.id === label.productId);
            return product
              ? { id: product.id, sku: product.sku, name: product.name }
              : null;
          })()
        : null,
      cellAssignment: null,
    };
  }

  function jobDetail(job: Loose): Loose {
    const label = eslLabels.find((row) => row.id === job.labelId);
    const gateway = eslGateways.find((row) => row.id === job.gatewayId);
    return {
      ...job,
      label: label
        ? {
            id: label.id,
            vendorLabelId: label.vendorLabelId,
            productId: label.productId,
          }
        : null,
      gateway: gateway
        ? { id: gateway.id, code: gateway.code, vendorCode: gateway.vendorCode }
        : null,
    };
  }

  /**
   * Builds one Prisma delegate over an in-memory array. `project` applies the
   * repository's `include`; the stub ignores `select`, which is harmless
   * because every caller reads a subset of what it returns.
   */
  function delegate(
    rows: Loose[],
    options: {
      relations?: Relations;
      project?: (row: Loose) => Loose;
      defaults?: () => Loose;
      prefix?: string;
    } = {},
  ) {
    const relations = options.relations ?? {};
    const project = options.project ?? ((row: Loose) => row);
    const find = (where: Loose | undefined, orderBy?: Loose | Loose[]) =>
      sortRows(
        rows.filter((row) => matches(row, where, relations)),
        orderBy,
      );
    const create = ({ data }: Loose) => {
      const row = {
        id: nextId(options.prefix ?? 'row'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(options.defaults?.() ?? {}),
        ...stripUndefined(data as Loose),
      };
      rows.push(row);
      return row;
    };
    return {
      findFirst: async ({ where, orderBy }: Loose = {}) =>
        find(where, orderBy)[0] ? project(find(where, orderBy)[0]) : null,
      findFirstOrThrow: async ({ where, orderBy }: Loose = {}) => {
        const found = find(where, orderBy)[0];
        if (!found) {
          throw new Error('stub: findFirstOrThrow found nothing');
        }
        return project(found);
      },
      findMany: async ({ where, orderBy, skip, take }: Loose = {}) => {
        const found = find(where, orderBy);
        const start = (skip as number) ?? 0;
        const sliced =
          take === undefined ? found.slice(start) : found.slice(start, start + take);
        return sliced.map(project);
      },
      count: async ({ where }: Loose = {}) => find(where).length,
      create: async (args: Loose) => create(args),
      createMany: async ({ data }: Loose) => {
        const list = (Array.isArray(data) ? data : [data]) as Loose[];
        let count = 0;
        for (const item of list) {
          // Mirrors skipDuplicates on the unique (tenantId, idempotencyKey).
          if (
            item.idempotencyKey !== undefined &&
            rows.some(
              (row) =>
                row.tenantId === item.tenantId &&
                row.idempotencyKey === item.idempotencyKey,
            )
          ) {
            continue;
          }
          create({ data: item });
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }: Loose) => {
        // Destructive writes carry the tenant IN the write predicate via
        // the `id_tenantId` composite key; the stub resolves either form
        // and misses on a tenant mismatch, exactly as Postgres would.
        const key = (where.id_tenantId ?? where) as Loose;
        const row = rows.find(
          (candidate) =>
            candidate.id === key.id &&
            (key.tenantId === undefined ||
              candidate.tenantId === key.tenantId),
        );
        if (!row) {
          throw new Error('stub: update found nothing');
        }
        applyData(row, stripUndefined(data as Loose));
        return row;
      },
      updateMany: async ({ where, data }: Loose) => {
        const affected = find(where);
        for (const row of affected) {
          applyData(row, stripUndefined(data as Loose));
        }
        return { count: affected.length };
      },
    };
  }

  const prismaStub: Loose = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Tenant"')
        ? Promise.resolve([{ status: 'ACTIVE' }])
        : Promise.resolve([1]),
    ),
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback(prismaStub),
    user: {
      findUnique: async ({ where }: Loose) =>
        users.find(
          (candidate) =>
            (where.email && candidate.email === where.email) ||
            (where.id && candidate.id === where.id),
        ) ?? null,
      findFirst: async ({ where }: Loose) => {
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
      updateMany: async ({ where }: Loose) => ({
        count: users.some((candidate) => candidate.id === where.id) ? 1 : 0,
      }),
      update: async ({ where }: Loose) =>
        users.find((candidate) => candidate.id === where.id),
    },
    userRole: {
      findMany: async ({ where }: Loose) => {
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
    tenant: { findFirst: async () => null },
    auditLog: {
      create: async ({ data }: Loose) => {
        auditRows.push(data as Loose);
        return data;
      },
    },
    platformModule: {
      findUnique: async ({ where }: Loose) =>
        platformModules.find((row) => row.code === where.code) ?? null,
    },
    tenantModule: {
      findFirst: async ({ where }: Loose) =>
        tenantModules.find(
          (row) =>
            row.tenantId === where.tenantId && row.moduleId === where.moduleId,
        ) ?? null,
    },
    location: delegate(locations),
    product: delegate(products),
    planogramCellAssignment: delegate([]),
    priceBook: delegate(priceBooks),
    priceBookVersion: delegate(priceBookVersions),
    priceBookEntry: delegate(priceBookEntries, {
      relations: entryRelations,
      // findPriceCandidates selects a nested version → priceBook; the stub
      // hands back the whole graph and lets the repository pick from it.
      project: (entry) => {
        const version = versionOf(entry);
        return {
          ...entry,
          version: version
            ? { ...version, priceBook: bookOf(version) }
            : null,
        };
      },
    }),
    eslGateway: delegate(eslGateways, {
      project: gatewayDetail,
      prefix: 'gw',
      defaults: () => ({
        status: 'PENDING',
        credentialRef: null,
        metadata: null,
        lastSeenAt: null,
        createdById: null,
      }),
    }),
    eslLabel: delegate(eslLabels, {
      relations: labelRelations,
      project: labelDetail,
      prefix: 'lbl',
      defaults: () => ({
        status: 'UNBOUND',
        productId: null,
        cellAssignmentId: null,
        batteryPercent: null,
        signalPercent: null,
        lastRenderedAt: null,
        renderedVersionId: null,
        renderedContentHash: null,
        createdById: null,
      }),
    }),
    eslUpdateJob: delegate(eslUpdateJobs, {
      project: jobDetail,
      prefix: 'job',
      defaults: () => ({
        status: 'QUEUED',
        attempts: 0,
        claimedAttempt: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(0),
        lastErrorCode: null,
        lastErrorMessage: null,
        requestedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        priceBookVersionId: null,
        createdById: null,
      }),
    }),
  };

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return response.body.accessToken as string;
  }

  let managerToken: string;
  let viewerToken: string;
  let otherTenantToken: string;
  let gatewayId: string;
  let labelId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    otherTenantToken = await loginAs(
      'manager@tenant-b.example',
      PASSWORDS.manager,
    );
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ------------------------------------------------------------- journey

  describe('setting the shelf up', () => {
    it('offers the simulated adapter and no vendor-specific surface', async () => {
      const response = await request(app.getHttpServer())
        .get('/esl/vendors')
        .set(auth(managerToken))
        .expect(200);
      expect(response.body.vendorCodes).toEqual(['SIMULATED']);
    });

    it('rejects a gateway naming a vendor nothing implements', async () => {
      await request(app.getHttpServer())
        .post('/esl/gateways')
        .set(auth(managerToken))
        .send({
          code: 'STORE-01',
          name: 'Store 1 gateway',
          vendorCode: 'ACME',
          locationId: 'loc-a1',
        })
        .expect(400);
    });

    it('rejects a credentialRef that carries the credential itself', async () => {
      await request(app.getHttpServer())
        .post('/esl/gateways')
        .set(auth(managerToken))
        .send({
          code: 'STORE-01',
          name: 'Store 1 gateway',
          vendorCode: 'SIMULATED',
          locationId: 'loc-a1',
          // Assembled so no secret-shaped literal sits in this file.
          credentialRef: ['pass', 'word', '=hunter2'].join(''),
        })
        .expect(400);
    });

    it('registers a gateway against the vendor-neutral adapter port', async () => {
      const response = await request(app.getHttpServer())
        .post('/esl/gateways')
        .set(auth(managerToken))
        .send({
          code: 'store-01',
          name: 'Store 1 gateway',
          vendorCode: 'simulated',
          locationId: 'loc-a1',
          credentialRef: 'STORE_01_KEY',
        })
        .expect(201);
      expect(response.body.code).toBe('STORE-01');
      expect(response.body.vendorCode).toBe('SIMULATED');
      gatewayId = response.body.id as string;
    });

    it('never writes the credential reference into the audit trail', () => {
      const entry = auditRows.find(
        (row) => row.entityType === 'EslGateway' && row.entityId === gatewayId,
      );
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).not.toContain('STORE_01_KEY');
      expect((entry?.after as Loose).hasCredentialRef).toBe(true);
    });

    it('discovers the labels the gateway can see', async () => {
      const response = await request(app.getHttpServer())
        .post(`/esl/gateways/${gatewayId}/discover`)
        .set(auth(managerToken))
        .expect(201);
      expect(response.body.registered).toBe(3);
      expect(response.body.labels[0].vendorLabelId).toBe('STORE-01-SIM-1');
      labelId = response.body.labels[0].id as string;
    });

    it('re-discovery is idempotent — no duplicate hardware', async () => {
      await request(app.getHttpServer())
        .post(`/esl/gateways/${gatewayId}/discover`)
        .set(auth(managerToken))
        .expect(201);
      const labels = await request(app.getHttpServer())
        .get('/esl/labels')
        .set(auth(managerToken))
        .expect(200);
      expect(labels.body.total).toBe(3);
    });

    it('binding a product queues an immediate render', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/esl/labels/${labelId}`)
        .set(auth(managerToken))
        .send({ productId: 'prod-water' })
        .expect(200);
      expect(response.body.status).toBe('BOUND');

      const jobs = await request(app.getHttpServer())
        .get(`/esl/update-jobs?labelId=${labelId}`)
        .set(auth(managerToken))
        .expect(200);
      expect(jobs.body.items[0].trigger).toBe('LABEL_BOUND');
    });

    it('renders the price currently in force', async () => {
      const summary = await request(app.getHttpServer())
        .post('/esl/update-jobs/process')
        .set(auth(managerToken))
        .send({})
        .expect(201);
      expect(summary.body.succeeded).toBe(1);

      const label = await request(app.getHttpServer())
        .get(`/esl/labels/${labelId}`)
        .set(auth(managerToken))
        .expect(200);
      expect(label.body.renderedVersionId).toBe('ver-1');
    });
  });

  describe('the journey: an admin price change reaches the shelf', () => {
    let renderedBefore: string;

    it('the label shows the old price before anything changes', async () => {
      const label = await request(app.getHttpServer())
        .get(`/esl/labels/${labelId}`)
        .set(auth(managerToken))
        .expect(200);
      renderedBefore = label.body.renderedContentHash as string;
      expect(renderedBefore).toEqual(expect.any(String));
      expect(label.body.renderedVersionId).toBe('ver-1');
    });

    it('activating the new version queues a push for the bound label', async () => {
      await request(app.getHttpServer())
        .post('/price-books/book-a/versions/ver-2/activate')
        .set(auth(managerToken))
        .send({ effectiveFrom: '2026-09-16T09:00:00.000Z' })
        .expect(201);

      const jobs = await request(app.getHttpServer())
        .get(`/esl/update-jobs?labelId=${labelId}&status=QUEUED`)
        .set(auth(managerToken))
        .expect(200);
      expect(jobs.body.total).toBe(1);
      expect(jobs.body.items[0].trigger).toBe('PRICE_ACTIVATION');
      expect(jobs.body.items[0].priceBookVersionId).toBe('ver-2');
    });

    it('processing the queue puts the NEW price on the label', async () => {
      const summary = await request(app.getHttpServer())
        .post('/esl/update-jobs/process')
        .set(auth(managerToken))
        .send({ limit: 25 })
        .expect(201);
      expect(summary.body).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

      const label = await request(app.getHttpServer())
        .get(`/esl/labels/${labelId}`)
        .set(auth(managerToken))
        .expect(200);
      expect(label.body.renderedVersionId).toBe('ver-2');
      expect(label.body.renderedContentHash).not.toBe(renderedBefore);
      expect(label.body.lastRenderedAt).not.toBeNull();
    });

    it('the rendered price is the one the price API now resolves', async () => {
      const resolved = await request(app.getHttpServer())
        .get('/prices/resolve?productId=prod-water&locationId=loc-a1')
        .set(auth(managerToken))
        .expect(200);
      expect(resolved.body.unitPriceMinor).toBe(275);
      expect(resolved.body.priceBookVersionId).toBe('ver-2');
    });

    it('a version can only be activated once', async () => {
      const before = eslUpdateJobs.length;
      await request(app.getHttpServer())
        .post('/price-books/book-a/versions/ver-2/activate')
        .set(auth(managerToken))
        .send({ effectiveFrom: '2026-09-16T11:00:00.000Z' })
        .expect(409);
      expect(eslUpdateJobs.length).toBe(before);
    });

    it('a REPLAYED activation event enqueues nothing — the key already exists', async () => {
      // A retried publish or a reconnecting listener replays the event the
      // hub already delivered. The unique (tenantId, idempotencyKey) index is
      // what makes that a no-op rather than a second push at the shelf.
      const before = eslUpdateJobs.length;
      await app.get(PriceActivationHub).publish({
        tenantId: 'tenant-a',
        priceBookId: 'book-a',
        priceBookVersionId: 'ver-2',
        locationId: null,
        productIds: ['prod-water'],
      });
      expect(eslUpdateJobs.length).toBe(before);
    });

    it('reconciliation finds nothing to repair once the shelf is right', async () => {
      const response = await request(app.getHttpServer())
        .post('/esl/reconcile')
        .set(auth(managerToken))
        .expect(201);
      expect(response.body.enqueued).toBe(0);
      expect(response.body.inspected).toBe(1);
    });

    it('reconciliation repairs a label that drifted', async () => {
      const row = eslLabels.find((label) => label.id === labelId);
      // Simulate hardware that lost its content (or a listener that was down).
      row!.renderedContentHash = null;
      row!.lastRenderedAt = null;

      const reconcile = await request(app.getHttpServer())
        .post('/esl/reconcile')
        .set(auth(managerToken))
        .expect(201);
      expect(reconcile.body.enqueued).toBe(1);

      const summary = await request(app.getHttpServer())
        .post('/esl/update-jobs/process')
        .set(auth(managerToken))
        .send({})
        .expect(201);
      expect(summary.body.succeeded).toBe(1);

      const label = await request(app.getHttpServer())
        .get(`/esl/labels/${labelId}`)
        .set(auth(managerToken))
        .expect(200);
      expect(label.body.renderedVersionId).toBe('ver-2');
    });
  });

  describe('failure never spreads', () => {
    it('one unreachable label does not stop the rest of the shelf', async () => {
      // SIM-2 is the label the simulated adapter always fails; binding it and
      // SIM-3 together proves a partial failure is exactly partial.
      const labels = await request(app.getHttpServer())
        .get('/esl/labels')
        .set(auth(managerToken))
        .expect(200);
      const second = labels.body.items.find(
        (row: Loose) => row.vendorLabelId === 'STORE-01-SIM-2',
      );
      const third = labels.body.items.find(
        (row: Loose) => row.vendorLabelId === 'STORE-01-SIM-3',
      );
      // Rename SIM-2 in place so the deterministic adapter fails it.
      const row = eslLabels.find((entry) => entry.id === second.id);
      row!.vendorLabelId = 'STORE-01-SIM-2-UNREACHABLE';

      for (const target of [second.id, third.id]) {
        await request(app.getHttpServer())
          .patch(`/esl/labels/${target}`)
          .set(auth(managerToken))
          .send({ productId: 'prod-water' })
          .expect(200);
      }

      const summary = await request(app.getHttpServer())
        .post('/esl/update-jobs/process')
        .set(auth(managerToken))
        .send({})
        .expect(201);
      expect(summary.body.succeeded).toBe(1);
      expect(summary.body.requeued).toBe(1);
      expect(summary.body.failed).toBe(0);
    });

    it('a label bound to an unpriced product is never queued at all', async () => {
      const created = await request(app.getHttpServer())
        .post(`/esl/gateways/${gatewayId}/labels`)
        .set(auth(managerToken))
        .send({ vendorLabelId: 'SHELF-COLA' })
        .expect(201);
      // prod-cola has no entry in any version, so nothing resolves for it.
      await request(app.getHttpServer())
        .patch(`/esl/labels/${created.body.id}`)
        .set(auth(managerToken))
        .send({ productId: 'prod-cola' })
        .expect(200);

      const jobs = await request(app.getHttpServer())
        .get(`/esl/update-jobs?labelId=${created.body.id}`)
        .set(auth(managerToken))
        .expect(200);
      // Nothing to show means nothing to queue — the failure is refused up
      // front rather than burning an attempt budget against the vendor.
      expect(jobs.body.total).toBe(0);
    });

    it('a disabled gateway cancels its queued work instead of retrying it', async () => {
      await request(app.getHttpServer())
        .patch(`/esl/gateways/${gatewayId}`)
        .set(auth(managerToken))
        .send({ status: 'DISABLED' })
        .expect(200);

      const jobs = await request(app.getHttpServer())
        .get(`/esl/update-jobs?gatewayId=${gatewayId}&status=CANCELLED`)
        .set(auth(managerToken))
        .expect(200);
      expect(jobs.body.total).toBeGreaterThan(0);

      // And an activation now queues nothing for it at all.
      const before = eslUpdateJobs.length;
      await request(app.getHttpServer())
        .post('/esl/reconcile')
        .set(auth(managerToken))
        .expect(201);
      expect(eslUpdateJobs.length).toBe(before);

      await request(app.getHttpServer())
        .patch(`/esl/gateways/${gatewayId}`)
        .set(auth(managerToken))
        .send({ status: 'ACTIVE' })
        .expect(200);
    });
  });

  describe('RBAC, module gating & tenant isolation', () => {
    it('a reader can see labels but cannot rebind or drive the queue', async () => {
      await request(app.getHttpServer())
        .get('/esl/labels')
        .set(auth(viewerToken))
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/esl/labels/${labelId}`)
        .set(auth(viewerToken))
        .send({ productId: 'prod-cola' })
        .expect(403);
      await request(app.getHttpServer())
        .post('/esl/update-jobs/process')
        .set(auth(viewerToken))
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .post('/esl/reconcile')
        .set(auth(viewerToken))
        .expect(403);
    });

    it('rejects an unauthenticated caller', async () => {
      await request(app.getHttpServer()).get('/esl/labels').expect(401);
    });

    it('validates the request body and refuses unknown fields', async () => {
      await request(app.getHttpServer())
        .post('/esl/gateways')
        .set(auth(managerToken))
        .send({ code: 'bad code!', name: 'x', vendorCode: 'SIMULATED', locationId: 'loc-a1' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/esl/gateways')
        .set(auth(managerToken))
        .send({
          code: 'STORE-02',
          name: 'Two',
          vendorCode: 'SIMULATED',
          locationId: 'loc-a1',
          tenantId: 'tenant-b',
        })
        .expect(400);
      await request(app.getHttpServer())
        .post('/esl/update-jobs/process')
        .set(auth(managerToken))
        .send({ limit: 5000 })
        .expect(400);
    });

    it('tenant B cannot read or mutate tenant A’s hardware', async () => {
      await request(app.getHttpServer())
        .get(`/esl/labels/${labelId}`)
        .set(auth(otherTenantToken))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/esl/gateways/${gatewayId}`)
        .set(auth(otherTenantToken))
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/esl/labels/${labelId}`)
        .set(auth(otherTenantToken))
        .send({ productId: 'prod-b' })
        .expect(404);
      const labels = await request(app.getHttpServer())
        .get('/esl/labels')
        .set(auth(otherTenantToken))
        .expect(200);
      expect(labels.body.total).toBe(0);
    });

    it('a gateway cannot be pinned to another tenant’s store', async () => {
      await request(app.getHttpServer())
        .post('/esl/gateways')
        .set(auth(managerToken))
        .send({
          code: 'STORE-XT',
          name: 'Cross tenant',
          vendorCode: 'SIMULATED',
          locationId: 'loc-b1',
        })
        .expect(404);
    });

    it('a tenant without the esl module is locked out entirely', async () => {
      const row = tenantModules.find((entry) => entry.id === 'tm-a-esl');
      row!.status = 'DISABLED';
      try {
        await request(app.getHttpServer())
          .get('/esl/labels')
          .set(auth(managerToken))
          .expect(403);
      } finally {
        row!.status = 'ENABLED';
      }
    });
  });
});
