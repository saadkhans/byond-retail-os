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

describe('Stores, Units & Devices (e2e, no live database)', () => {
  let app: INestApplication;
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

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

  const grants: Record<string, { tenantId: string | null; codes: string[] }> =
    {
      'admin-1': { tenantId: null, codes: ['tenant:read', 'module:read'] },
      'manager-a': {
        tenantId: 'tenant-a',
        codes: [
          'location:read',
          'location:manage',
          'unit:read',
          'unit:manage',
          'device:read',
          'device:manage',
          'device:register',
          'device:heartbeat',
        ],
      },
      'viewer-a': {
        tenantId: 'tenant-a',
        codes: ['location:read', 'unit:read', 'device:read'],
      },
    };

  // Module catalog + per-tenant enablement backing the ModuleEnabledGuard.
  const platformModules = [
    { id: 'module-core', code: 'core', name: 'Core', isActive: true },
    {
      id: 'module-devices',
      code: 'devices',
      name: 'Units & Devices',
      isActive: true,
    },
  ];
  const tenantModules = [
    {
      id: 'tm-a-devices',
      tenantId: 'tenant-a',
      moduleId: 'module-devices',
      status: 'ENABLED',
    },
  ];

  // Stateful in-memory tables. Tenant B rows exist purely as cross-tenant
  // "bait" — every test asserts they stay invisible to tenant A callers.
  const store = {
    locations: [
      {
        id: 'loc-b1',
        tenantId: 'tenant-b',
        name: 'Tenant B Downtown',
        code: 'B-DT-1',
        type: 'STORE',
        status: 'ACTIVE',
        timezone: 'UTC',
        address: null,
      },
    ] as Row[],
    units: [
      {
        id: 'unit-b1',
        tenantId: 'tenant-b',
        locationId: 'loc-b1',
        code: 'B-FRIDGE-1',
        name: 'Tenant B Fridge',
        type: 'SMART_FRIDGE',
        status: 'ACTIVE',
        placement: null,
      },
    ] as Row[],
    devices: [
      {
        id: 'device-b1',
        tenantId: 'tenant-b',
        unitId: 'unit-b1',
        name: 'Tenant B Camera',
        type: 'CAMERA',
        status: 'ONLINE',
        serialNumber: 'SN-SHARED-1',
        metadata: null,
        firmwareVersion: null,
        softwareVersion: null,
        lastSeenAt: null,
        registrationTokenHash: null,
        registrationTokenExpiresAt: null,
        registeredAt: null,
      },
    ] as Row[],
    // No inventory in this suite, but location deletion consults these.
    levels: [] as Row[],
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

  function matchSearchOr(row: Row, where: Where, fields: string[]): boolean {
    if (!Array.isArray(where.OR)) {
      return true;
    }
    return where.OR.some((clause: Where) =>
      fields.some((field) => {
        const contains = clause[field]?.contains;
        return (
          contains !== undefined &&
          String(row[field])
            .toLowerCase()
            .includes(String(contains).toLowerCase())
        );
      }),
    );
  }

  // Prisma applies column defaults when a create field is undefined; a naive
  // spread would clobber the stub's defaults with undefined instead.
  function stripUndefined(data: Where): Where & { tenantId: string } {
    return Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    ) as Where & { tenantId: string };
  }

  function withTimestamps<T extends object>(row: T): T & {
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      createdAt: new Date('2026-07-11T00:00:00Z'),
      updatedAt: new Date('2026-07-11T00:00:00Z'),
      ...row,
    } as T & { createdAt: Date; updatedAt: Date };
  }

  function locationSelect(locationId: unknown) {
    const location = store.locations.find((row) => row.id === locationId);
    return location
      ? {
          id: location.id,
          name: location.name,
          code: location.code,
          status: location.status,
        }
      : null;
  }

  function unitSelect(unitId: unknown) {
    const unit = store.units.find((row) => row.id === unitId);
    return unit
      ? {
          id: unit.id,
          code: unit.code,
          name: unit.name,
          status: unit.status,
          locationId: unit.locationId,
        }
      : null;
  }

  function unitWithInclude(unit: Row, args: Where) {
    return args.include?.location
      ? { ...unit, location: locationSelect(unit.locationId) }
      : unit;
  }

  // Honors Prisma's `omit` (the repositories always omit the registration
  // token hash) and `include` for device reads.
  function deviceShape(device: Row, args: Where) {
    const result: Row = { ...device };
    if (args.omit?.registrationTokenHash) {
      delete result.registrationTokenHash;
    }
    if (args.include?.unit) {
      result.unit = unitSelect(device.unitId);
    }
    return result;
  }

  const prismaStub = {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Tenant"')
        ? Promise.resolve([{ status: 'ACTIVE' }])
        : Promise.resolve([1]),
    ),
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback(prismaStub),
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
      create: async ({ data }: { data: Where }) => {
        if (
          store.locations.some(
            (row) => row.tenantId === data.tenantId && row.code === data.code,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = withTimestamps({
          id: nextId('loc'),
          status: 'ACTIVE',
          timezone: 'UTC',
          address: null,
          ...stripUndefined(data),
        }) as Row;
        store.locations.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.locations.find((row) =>
          matchScalar(row, where, ['id', 'tenantId']),
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
        store.locations
          .filter(
            (row) =>
              matchScalar(row, where, ['tenantId', 'type', 'status']) &&
              matchSearchOr(row, where, ['name', 'code']),
          )
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25)),
      count: async ({ where }: { where: Where }) =>
        store.locations.filter(
          (row) =>
            matchScalar(row, where, ['tenantId', 'type', 'status']) &&
            matchSearchOr(row, where, ['name', 'code']),
        ).length,
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.locations.find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) {
          throw { code: 'P2025' };
        }
        Object.assign(row, stripUndefined(data));
        return row;
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.locations.find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) {
          throw { code: 'P2025' };
        }
        const referenced =
          store.units.some((unit) => unit.locationId === row.id) ||
          store.levels.some((level) => level.locationId === row.id) ||
          store.movements.some((movement) => movement.locationId === row.id);
        if (referenced) {
          throw { code: 'P2003' };
        }
        store.locations = store.locations.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
    },
    retailUnit: {
      create: async (args: { data: Where; include?: Where }) => {
        const { data } = args;
        if (
          store.units.some(
            (row) => row.tenantId === data.tenantId && row.code === data.code,
          )
        ) {
          throw { code: 'P2002' };
        }
        // Composite same-tenant FK: the store must exist in the SAME tenant.
        if (
          !store.locations.some(
            (row) =>
              row.id === data.locationId && row.tenantId === data.tenantId,
          )
        ) {
          throw { code: 'P2003' };
        }
        const row = withTimestamps({
          id: nextId('unit'),
          status: 'DRAFT',
          placement: null,
          ...stripUndefined(data),
        }) as Row;
        store.units.push(row);
        return unitWithInclude(row, args);
      },
      findFirst: async (args: { where: Where; include?: Where }) => {
        const row = store.units.find((candidate) =>
          matchScalar(candidate, args.where, ['id', 'tenantId']),
        );
        return row ? unitWithInclude(row, args) : null;
      },
      findMany: async (args: {
        where: Where;
        include?: Where;
        skip?: number;
        take?: number;
      }) =>
        store.units
          .filter(
            (row) =>
              matchScalar(row, args.where, [
                'tenantId',
                'locationId',
                'type',
                'status',
              ]) && matchSearchOr(row, args.where, ['name', 'code']),
          )
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 25))
          .map((row) => unitWithInclude(row, args)),
      count: async ({ where }: { where: Where }) =>
        store.units.filter(
          (row) =>
            matchScalar(row, where, [
              'tenantId',
              'locationId',
              'type',
              'status',
            ]) && matchSearchOr(row, where, ['name', 'code']),
        ).length,
      update: async (args: { where: Where; data: Where; include?: Where }) => {
        const row = store.units.find(
          (candidate) => candidate.id === args.where.id,
        );
        if (!row) {
          throw { code: 'P2025' };
        }
        if (
          args.data.locationId !== undefined &&
          !store.locations.some(
            (location) =>
              location.id === args.data.locationId &&
              location.tenantId === row.tenantId,
          )
        ) {
          throw { code: 'P2003' };
        }
        Object.assign(row, stripUndefined(args.data));
        if (args.data.placement === null) {
          row.placement = null;
        }
        return unitWithInclude(row, args);
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.units.find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) {
          throw { code: 'P2025' };
        }
        store.units = store.units.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
    },
    device: {
      create: async (args: { data: Where; include?: Where; omit?: Where }) => {
        const { data } = args;
        if (
          store.devices.some(
            (row) =>
              row.tenantId === data.tenantId &&
              row.serialNumber === data.serialNumber,
          )
        ) {
          throw { code: 'P2002' };
        }
        // Composite same-tenant FK: the unit must exist in the SAME tenant.
        if (
          !store.units.some(
            (row) => row.id === data.unitId && row.tenantId === data.tenantId,
          )
        ) {
          throw { code: 'P2003' };
        }
        const row = withTimestamps({
          id: nextId('device'),
          status: 'PROVISIONED',
          metadata: null,
          firmwareVersion: null,
          softwareVersion: null,
          lastSeenAt: null,
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
          registeredAt: null,
          ...stripUndefined(data),
        }) as Row;
        store.devices.push(row);
        return deviceShape(row, args);
      },
      findUnique: async (args: { where: Where }) =>
        args.where.registrationTokenHash !== undefined
          ? (store.devices.find(
              (row) =>
                row.registrationTokenHash === args.where.registrationTokenHash,
            ) ?? null)
          : (store.devices.find((row) => row.id === args.where.id) ?? null),
      findFirst: async (args: {
        where: Where;
        include?: Where;
        omit?: Where;
      }) => {
        const row = store.devices.find((candidate) =>
          matchScalar(candidate, args.where, [
            'id',
            'tenantId',
            'registrationTokenHash',
          ]),
        );
        return row ? deviceShape(row, args) : null;
      },
      findMany: async (args: {
        where: Where;
        include?: Where;
        omit?: Where;
        skip?: number;
        take?: number;
      }) =>
        store.devices
          .filter(
            (row) =>
              matchScalar(row, args.where, [
                'tenantId',
                'unitId',
                'type',
                'status',
              ]) && matchSearchOr(row, args.where, ['name', 'serialNumber']),
          )
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 25))
          .map((row) => deviceShape(row, args)),
      count: async ({ where }: { where: Where }) =>
        store.devices.filter((row) =>
          matchScalar(row, where, ['tenantId', 'unitId', 'type', 'status']),
        ).length,
      update: async (args: {
        where: Where;
        data: Where;
        include?: Where;
        omit?: Where;
      }) => {
        const row = store.devices.find(
          (candidate) => candidate.id === args.where.id,
        );
        if (!row) {
          throw { code: 'P2025' };
        }
        if (
          args.data.unitId !== undefined &&
          !store.units.some(
            (unit) =>
              unit.id === args.data.unitId && unit.tenantId === row.tenantId,
          )
        ) {
          throw { code: 'P2003' };
        }
        Object.assign(row, stripUndefined(args.data));
        // Prisma writes explicit nulls; stripUndefined would drop them.
        for (const key of [
          'registrationTokenHash',
          'registrationTokenExpiresAt',
        ]) {
          if (args.data[key] === null) {
            row[key] = null;
          }
        }
        return deviceShape(row, args);
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.devices.find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) {
          throw { code: 'P2025' };
        }
        store.devices = store.devices.filter(
          (candidate) => candidate.id !== row.id,
        );
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

  let storeId: string;
  let emptyStoreId: string;
  let unitId: string;
  let deviceId: string;

  describe('stores CRUD, RBAC & tenant isolation', () => {
    it('unauthenticated requests are rejected', async () => {
      await request(app.getHttpServer()).get('/stores').expect(401);
    });

    it('platform users are rejected from tenant store endpoints', async () => {
      await request(app.getHttpServer())
        .get('/stores')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });

    it('a viewer WITHOUT location:manage cannot create; denial is audited', async () => {
      await request(app.getHttpServer())
        .post('/stores')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ name: 'Sneaky', code: 'SNK-1', type: 'STORE' })
        .expect(403);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACCESS_DENIED' }),
        }),
      );
      expect(store.locations.some((l) => l.name === 'Sneaky')).toBe(false);
    });

    it('a manager creates a store; tenantId comes from the token; audited', async () => {
      const response = await request(app.getHttpServer())
        .post('/stores')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Downtown Flagship',
          code: 'dt-001',
          type: 'STORE',
          timezone: 'Europe/Berlin',
          address: { street: 'Main St 1', city: 'Berlin' },
        })
        .expect(201);
      storeId = response.body.id;
      expect(response.body.tenantId).toBe('tenant-a');
      expect(response.body.code).toBe('DT-001');
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entityType: 'Location',
            tenantId: 'tenant-a',
            actorId: 'manager-a',
          }),
        }),
      );

      const second = await request(app.getHttpServer())
        .post('/stores')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Airport Kiosk Site', code: 'AP-001', type: 'POPUP' })
        .expect(201);
      emptyStoreId = second.body.id;
    });

    it('duplicate store codes conflict (409)', async () => {
      await request(app.getHttpServer())
        .post('/stores')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Clone', code: 'DT-001', type: 'STORE' })
        .expect(409);
    });

    it('a tenantId in the body is rejected outright (400)', async () => {
      await request(app.getHttpServer())
        .post('/stores')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Evil',
          code: 'EVIL-1',
          type: 'STORE',
          tenantId: 'tenant-b',
        })
        .expect(400);
    });

    it('search paginates deterministically and NEVER leaks tenant B', async () => {
      const page = await request(app.getHttpServer())
        .get('/stores?search=down&skip=0&take=10')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      // "Tenant B Downtown" matches the fragment but belongs to tenant-b.
      expect(page.body.total).toBe(1);
      expect(page.body.items[0].id).toBe(storeId);
      expect(
        page.body.items.every(
          (item: { tenantId: string }) => item.tenantId === 'tenant-a',
        ),
      ).toBe(true);

      const filtered = await request(app.getHttpServer())
        .get('/stores?type=POPUP')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(filtered.body.total).toBe(1);
      expect(filtered.body.items[0].id).toBe(emptyStoreId);
    });

    it('the /locations alias serves the same store API', async () => {
      const response = await request(app.getHttpServer())
        .get(`/locations/${storeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(response.body.id).toBe(storeId);
    });

    it('cross-tenant reads and writes miss with 404', async () => {
      await request(app.getHttpServer())
        .get('/stores/loc-b1')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch('/stores/loc-b1')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Hijacked' })
        .expect(404);
      expect(
        store.locations.find((l) => l.id === 'loc-b1')?.name,
      ).toBe('Tenant B Downtown');
    });

    it('updates a store status and audits before/after', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/stores/${storeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'INACTIVE' })
        .expect(200);
      expect(response.body.status).toBe('INACTIVE');
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPDATE',
            entityType: 'Location',
            entityId: storeId,
            reason: 'Location updated (status change)',
          }),
        }),
      );
      await request(app.getHttpServer())
        .patch(`/stores/${storeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
    });
  });

  describe('units CRUD, lifecycle & tenant isolation', () => {
    it('creating a unit in another tenant’s store is rejected (400)', async () => {
      await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-b1',
          code: 'FRIDGE-001',
          name: 'Evil Fridge',
          type: 'SMART_FRIDGE',
        })
        .expect(400);
    });

    it('a viewer WITHOUT unit:manage cannot create (403)', async () => {
      await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          locationId: 'will-not-matter',
          code: 'X',
          name: 'X',
          type: 'KIOSK',
        })
        .expect(403);
    });

    it('a manager creates a unit; audited; code uppercased', async () => {
      const response = await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: storeId,
          code: 'fridge-001',
          name: 'Entrance Smart Fridge',
          type: 'SMART_FRIDGE',
          placement: 'Aisle 1, next to entrance',
        })
        .expect(201);
      unitId = response.body.id;
      expect(response.body.tenantId).toBe('tenant-a');
      expect(response.body.code).toBe('FRIDGE-001');
      expect(response.body.status).toBe('DRAFT');
      expect(response.body.location.id).toBe(storeId);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entityType: 'RetailUnit',
            tenantId: 'tenant-a',
            actorId: 'manager-a',
          }),
        }),
      );
    });

    it('duplicate unit codes conflict (409)', async () => {
      await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: storeId,
          code: 'FRIDGE-001',
          name: 'Clone',
          type: 'SMART_FRIDGE',
        })
        .expect(409);
    });

    it('a tenantId in the body is rejected outright (400)', async () => {
      await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: storeId,
          code: 'EVIL-1',
          name: 'Evil',
          type: 'KIOSK',
          tenantId: 'tenant-b',
        })
        .expect(400);
    });

    it('search filters by store and NEVER leaks tenant B units', async () => {
      const response = await request(app.getHttpServer())
        .get(`/units?search=fridge&locationId=${storeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      // "Tenant B Fridge" matches the fragment but belongs to tenant-b.
      expect(response.body.total).toBe(1);
      expect(response.body.items[0].id).toBe(unitId);
    });

    it('cross-tenant reads and writes miss with 404', async () => {
      await request(app.getHttpServer())
        .get('/units/unit-b1')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch('/units/unit-b1')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Hijacked' })
        .expect(404);
    });

    it('walks the lifecycle and audits status changes', async () => {
      await request(app.getHttpServer())
        .patch(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPDATE',
            entityType: 'RetailUnit',
            reason: 'Retail unit updated (status change)',
          }),
        }),
      );
      await request(app.getHttpServer())
        .patch(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'MAINTENANCE' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
    });

    it('rejects illegal lifecycle jumps (409) without persisting them', async () => {
      // The unit is ACTIVE here: an operational unit can never go back to DRAFT.
      await request(app.getHttpServer())
        .patch(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'DRAFT' })
        .expect(409);
      expect(store.units.find((u) => u.id === unitId)?.status).toBe('ACTIVE');
    });

    it('rejects creating a unit in a mid-lifecycle status (400)', async () => {
      await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: storeId,
          code: 'SKIP-1',
          name: 'Lifecycle Skipper',
          type: 'KIOSK',
          status: 'MAINTENANCE',
        })
        .expect(400);
    });

    it('reassigning a unit to another tenant’s store is rejected (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ locationId: 'loc-b1' })
        .expect(400);
    });

    it('DRAFT cannot be retired directly, and RETIRED is terminal (409)', async () => {
      const retired = await request(app.getHttpServer())
        .post('/units')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: storeId,
          code: 'RETIRE-ME',
          name: 'Old Kiosk',
          type: 'KIOSK',
        })
        .expect(201);
      // A never-operational DRAFT unit is deleted, not retired.
      await request(app.getHttpServer())
        .patch(`/units/${retired.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'RETIRED' })
        .expect(409);
      await request(app.getHttpServer())
        .patch(`/units/${retired.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/units/${retired.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'RETIRED' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/units/${retired.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(409);
      // Cleanup so later suites see a stable unit list.
      await request(app.getHttpServer())
        .delete(`/units/${retired.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
    });

    it('deleting a store with units is blocked (409)', async () => {
      await request(app.getHttpServer())
        .delete(`/stores/${storeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(409);
      expect(store.locations.some((l) => l.id === storeId)).toBe(true);
    });

    it('deleting an empty store succeeds and is audited', async () => {
      await request(app.getHttpServer())
        .delete(`/stores/${emptyStoreId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'DELETE',
            entityType: 'Location',
            entityId: emptyStoreId,
          }),
        }),
      );
    });
  });

  describe('devices CRUD, heartbeat & registration', () => {
    it('attaching a device to another tenant’s unit is rejected (400)', async () => {
      await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId: 'unit-b1',
          name: 'Evil Cam',
          type: 'CAMERA',
          serialNumber: 'SN-EVIL-1',
        })
        .expect(400);
    });

    it('a manager creates a device; audited; serial trimmed', async () => {
      const response = await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId,
          name: 'Front door lock',
          type: 'DOOR_LOCK',
          serialNumber: ' SN-LOCK-1 ',
          firmwareVersion: '1.0.0',
          metadata: { mountPosition: 'front' },
        })
        .expect(201);
      deviceId = response.body.id;
      expect(response.body.tenantId).toBe('tenant-a');
      expect(response.body.serialNumber).toBe('SN-LOCK-1');
      expect(response.body.status).toBe('PROVISIONED');
      expect(response.body.unit.id).toBe(unitId);
      expect(response.body).not.toHaveProperty('registrationTokenHash');
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entityType: 'Device',
            tenantId: 'tenant-a',
            actorId: 'manager-a',
          }),
        }),
      );
    });

    it('serials are unique per tenant — the same serial in tenant B is fine, a duplicate in tenant A conflicts', async () => {
      // Tenant B already owns SN-SHARED-1; tenant A may reuse it.
      const shared = await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId,
          name: 'Shelf sensor',
          type: 'SHELF_SENSOR',
          serialNumber: 'SN-SHARED-1',
        })
        .expect(201);
      // ... but not twice within tenant A.
      await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId,
          name: 'Clone sensor',
          type: 'SHELF_SENSOR',
          serialNumber: 'SN-SHARED-1',
        })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/devices/${shared.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
    });

    it('a tenantId in the body is rejected outright (400)', async () => {
      await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId,
          name: 'Evil',
          type: 'CAMERA',
          serialNumber: 'SN-EVIL-2',
          tenantId: 'tenant-b',
        })
        .expect(400);
    });

    it('credential/payment-shaped metadata is rejected outright (400)', async () => {
      await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId,
          name: 'Leaky terminal',
          type: 'PAYMENT_TERMINAL',
          serialNumber: 'SN-LEAK-1',
          metadata: { processor: { config: { apiKey: 'sk_live_secret' } } },
        })
        .expect(400);
      expect(
        store.devices.some((d) => d.serialNumber === 'SN-LEAK-1'),
      ).toBe(false);

      const before = store.devices.find((d) => d.id === deviceId)!.metadata;
      await request(app.getHttpServer())
        .patch(`/devices/${deviceId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ metadata: { payment: { cardNumber: '4111111111111111' } } })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/devices/${deviceId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ metadata: { reader: { track2: 'raw-stripe' } } })
        .expect(400);
      // Nothing was persisted — the stored metadata is untouched.
      expect(store.devices.find((d) => d.id === deviceId)!.metadata).toEqual(
        before,
      );
    });

    it('lastSeenAt is not client-writable (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/devices/${deviceId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ lastSeenAt: '2026-07-11T00:00:00Z' })
        .expect(400);
    });

    it('search NEVER leaks tenant B devices', async () => {
      const response = await request(app.getHttpServer())
        .get('/devices?search=SN-')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(
        response.body.items.every(
          (item: { tenantId: string }) => item.tenantId === 'tenant-a',
        ),
      ).toBe(true);
      await request(app.getHttpServer())
        .get('/devices/device-b1')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(404);
    });

    it('a viewer WITHOUT device:heartbeat cannot send heartbeats (403)', async () => {
      await request(app.getHttpServer())
        .post(`/devices/${deviceId}/heartbeat`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({})
        .expect(403);
    });

    it('heartbeat promotes PROVISIONED to ONLINE, bumps lastSeenAt, audits the transition', async () => {
      const response = await request(app.getHttpServer())
        .post(`/devices/${deviceId}/heartbeat`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ firmwareVersion: '1.0.1' })
        .expect(200);
      expect(response.body.status).toBe('ONLINE');
      expect(response.body.lastSeenAt).toBeTruthy();
      expect(response.body.firmwareVersion).toBe('1.0.1');
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'HEARTBEAT',
            entityType: 'Device',
            entityId: deviceId,
          }),
        }),
      );
    });

    it('a routine (no status change) heartbeat is NOT audited', async () => {
      await request(app.getHttpServer())
        .post(`/devices/${deviceId}/heartbeat`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(200);
      expect(auditCreateSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'HEARTBEAT' }),
        }),
      );
    });

    it('a DISABLED device refuses heartbeats (409)', async () => {
      await request(app.getHttpServer())
        .patch(`/devices/${deviceId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'DISABLED' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/devices/${deviceId}/heartbeat`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({})
        .expect(409);
      await request(app.getHttpServer())
        .patch(`/devices/${deviceId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'OFFLINE' })
        .expect(200);
    });

    it('RETIRED is terminal for devices (409)', async () => {
      const doomed = await request(app.getHttpServer())
        .post('/devices')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          unitId,
          name: 'Old camera',
          type: 'CAMERA',
          serialNumber: 'SN-OLD-1',
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/devices/${doomed.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'RETIRED' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/devices/${doomed.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ONLINE' })
        .expect(409);
      await request(app.getHttpServer())
        .delete(`/devices/${doomed.body.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
    });

    it('deleting a unit with devices is blocked (409)', async () => {
      await request(app.getHttpServer())
        .delete(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(409);
      expect(store.units.some((u) => u.id === unitId)).toBe(true);
    });

    describe('edge registration', () => {
      let registrationToken: string;

      it('a viewer WITHOUT device:register cannot issue tokens (403)', async () => {
        await request(app.getHttpServer())
          .post(`/devices/${deviceId}/registration-token`)
          .set('Authorization', `Bearer ${viewerToken}`)
          .expect(403);
      });

      it('issues a one-time token; only the hash is stored; audited without the token', async () => {
        const response = await request(app.getHttpServer())
          .post(`/devices/${deviceId}/registration-token`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(201);
        registrationToken = response.body.registrationToken;
        expect(registrationToken.length).toBeGreaterThanOrEqual(40);
        expect(response.body.expiresAt).toBeTruthy();

        const row = store.devices.find((d) => d.id === deviceId)!;
        expect(row.registrationTokenHash).toBeTruthy();
        expect(row.registrationTokenHash).not.toBe(registrationToken);

        // Audited as REGISTER — and the audit payload NEVER contains the
        // plaintext token or its hash.
        const registerCalls = auditCreateSpy.mock.calls.filter(
          ([arg]) => arg.data.action === 'REGISTER',
        );
        expect(registerCalls).toHaveLength(1);
        const serialized = JSON.stringify(registerCalls[0]);
        expect(serialized).not.toContain(registrationToken);
        expect(serialized).not.toContain(row.registrationTokenHash);
      });

      it('device reads never expose the token hash', async () => {
        const response = await request(app.getHttpServer())
          .get(`/devices/${deviceId}`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);
        expect(response.body).not.toHaveProperty('registrationTokenHash');
      });

      it('rejects an unknown token with the generic 401 (nothing consumed)', async () => {
        await request(app.getHttpServer())
          .post('/edge/register')
          .send({
            serialNumber: 'SN-LOCK-1',
            registrationToken: 'totally-wrong-token-value',
          })
          .expect(401);
        // The real, still-unredeemed token was not touched.
        expect(
          store.devices.find((d) => d.id === deviceId)!.registrationTokenHash,
        ).toBeTruthy();
      });

      it('redeems the token unauthenticated, marks the device ONLINE + registered, audits', async () => {
        const response = await request(app.getHttpServer())
          .post('/edge/register')
          .send({ serialNumber: 'SN-LOCK-1', registrationToken })
          .expect(200);
        expect(response.body).toEqual(
          expect.objectContaining({
            deviceId,
            tenantId: 'tenant-a',
            unitId,
            status: 'ONLINE',
          }),
        );
        expect(auditCreateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'REGISTER',
              entityType: 'Device',
              entityId: deviceId,
              tenantId: 'tenant-a',
            }),
          }),
        );
        const row = store.devices.find((d) => d.id === deviceId)!;
        expect(row.registrationTokenHash).toBeNull();
        expect(row.registeredAt).toBeTruthy();
      });

      it('the token is single-use (second redemption fails with 401)', async () => {
        await request(app.getHttpServer())
          .post('/edge/register')
          .send({ serialNumber: 'SN-LOCK-1', registrationToken })
          .expect(401);
      });

      it('an expired token is refused (401)', async () => {
        const issued = await request(app.getHttpServer())
          .post(`/devices/${deviceId}/registration-token`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(201);
        const row = store.devices.find((d) => d.id === deviceId)!;
        row.registrationTokenExpiresAt = new Date(Date.now() - 1000);
        await request(app.getHttpServer())
          .post('/edge/register')
          .send({
            serialNumber: 'SN-LOCK-1',
            registrationToken: issued.body.registrationToken,
          })
          .expect(401);
      });

      it('a devices-module-disabled tenant cannot redeem — same 401, nothing mutated', async () => {
        const issued = await request(app.getHttpServer())
          .post(`/devices/${deviceId}/registration-token`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(201);
        const row = store.devices.find((d) => d.id === deviceId)!;
        const snapshot = {
          status: row.status,
          lastSeenAt: row.lastSeenAt,
          registeredAt: row.registeredAt,
          registrationTokenHash: row.registrationTokenHash,
          registrationTokenExpiresAt: row.registrationTokenExpiresAt,
        };

        const enabled = tenantModules.pop()!;
        try {
          await request(app.getHttpServer())
            .post('/edge/register')
            .send({
              serialNumber: 'SN-LOCK-1',
              registrationToken: issued.body.registrationToken,
            })
            .expect(401);
          // No mutation at all: status, lastSeenAt, registeredAt, and the
          // token fields are untouched while the module is disabled.
          expect({
            status: row.status,
            lastSeenAt: row.lastSeenAt,
            registeredAt: row.registeredAt,
            registrationTokenHash: row.registrationTokenHash,
            registrationTokenExpiresAt: row.registrationTokenExpiresAt,
          }).toEqual(snapshot);
        } finally {
          tenantModules.push(enabled);
        }

        // Re-enabling the module lets the untouched token redeem normally.
        await request(app.getHttpServer())
          .post('/edge/register')
          .send({
            serialNumber: 'SN-LOCK-1',
            registrationToken: issued.body.registrationToken,
          })
          .expect(200);
      });

      it('a serial mismatch CONSUMES the token — the correct serial then fails too', async () => {
        const issued = await request(app.getHttpServer())
          .post(`/devices/${deviceId}/registration-token`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(201);
        const row = store.devices.find((d) => d.id === deviceId)!;
        expect(row.registrationTokenHash).toBeTruthy();

        await request(app.getHttpServer())
          .post('/edge/register')
          .send({
            serialNumber: 'SN-GUESSED-WRONG',
            registrationToken: issued.body.registrationToken,
          })
          .expect(401);
        // The token was invalidated by the mismatch (no serial-guessing
        // window), but nothing else about the device changed.
        expect(row.registrationTokenHash).toBeNull();
        expect(row.registrationTokenExpiresAt).toBeNull();

        await request(app.getHttpServer())
          .post('/edge/register')
          .send({
            serialNumber: 'SN-LOCK-1',
            registrationToken: issued.body.registrationToken,
          })
          .expect(401);
      });
    });

    it('after removing its devices, the unit can be deleted and is audited', async () => {
      for (const row of store.devices.filter(
        (d) => d.tenantId === 'tenant-a' && d.unitId === unitId,
      )) {
        await request(app.getHttpServer())
          .delete(`/devices/${row.id}`)
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(204);
      }
      await request(app.getHttpServer())
        .delete(`/units/${unitId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'DELETE',
            entityType: 'RetailUnit',
            entityId: unitId,
          }),
        }),
      );
    });
  });

  describe('module gate', () => {
    it('unit/device routes 403 when the devices module is disabled for the tenant', async () => {
      const enabled = tenantModules.pop()!;
      try {
        await request(app.getHttpServer())
          .get('/units')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
        await request(app.getHttpServer())
          .get('/devices')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
        // Stores are core — unaffected by the devices module gate.
        await request(app.getHttpServer())
          .get('/stores')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(200);
      } finally {
        tenantModules.push(enabled);
      }
    });
  });
});
