import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Deterministic in-memory fixture — no database (same pattern as
// auth.e2e-spec). Cost 4 keeps the suite fast.
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

describe('Catalog & Inventory (e2e, no live database)', () => {
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
          'catalog:read',
          'catalog:manage',
          'inventory:read',
          'inventory:adjust',
        ],
      },
      'viewer-a': {
        tenantId: 'tenant-a',
        codes: ['catalog:read', 'inventory:read'],
      },
    };

  const locations = [
    { id: 'loc-a1', tenantId: 'tenant-a', name: 'Store A1', code: 'A1' },
    { id: 'loc-b1', tenantId: 'tenant-b', name: 'Store B1', code: 'B1' },
  ];

  // Module catalog + per-tenant enablement backing the ModuleEnabledGuard.
  // Tenant A has the inventory module ENABLED for the whole suite; the
  // dedicated gate test toggles this row and restores it.
  const platformModules = [
    { id: 'module-core', code: 'core', name: 'Core', isActive: true },
    {
      id: 'module-inventory',
      code: 'inventory',
      name: 'Inventory',
      isActive: true,
    },
  ];
  const tenantModules = [
    {
      id: 'tm-a-inventory',
      tenantId: 'tenant-a',
      moduleId: 'module-inventory',
      status: 'ENABLED',
    },
  ];

  // Stateful in-memory tables. Tenant B rows exist purely as cross-tenant
  // "bait" — every test asserts they stay invisible to tenant A callers.
  const store = {
    categories: [
      {
        id: 'cat-b',
        tenantId: 'tenant-b',
        name: 'B Snacks',
        description: null,
        parentId: null,
      },
    ] as Row[],
    brands: [] as Row[],
    products: [
      {
        id: 'prod-b',
        tenantId: 'tenant-b',
        sku: 'B-SKU-1',
        name: 'Tenant B Cola',
        description: null,
        categoryId: null,
        brandId: null,
        unitOfMeasure: 'EACH',
        status: 'ACTIVE',
        lowStockThreshold: null,
      },
    ] as Row[],
    barcodes: [
      {
        id: 'bc-b',
        tenantId: 'tenant-b',
        productId: 'prod-b',
        value: 'BARCODE-B',
        format: 'OTHER',
      },
    ] as Row[],
    levels: [] as (Row & { quantity: number })[],
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
  // spread would clobber the stub's defaults with undefined instead. Every
  // repository create() passes tenantId, so the return type asserts it —
  // which also lets the object spreads below satisfy Row.
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
      createdAt: new Date('2026-07-08T00:00:00Z'),
      updatedAt: new Date('2026-07-08T00:00:00Z'),
      ...row,
    } as T & { createdAt: Date; updatedAt: Date };
  }

  function productWithInclude(product: Row) {
    return {
      ...product,
      barcodes: store.barcodes.filter(
        (barcode) => barcode.productId === product.id,
      ),
      category: product.categoryId
        ? (store.categories.find(
            (category) => category.id === product.categoryId,
          ) ?? null)
        : null,
      brand: product.brandId
        ? (store.brands.find((brand) => brand.id === product.brandId) ?? null)
        : null,
    };
  }

  function matchesProduct(product: Row, where: Where): boolean {
    if (
      !matchScalar(product, where, [
        'id',
        'tenantId',
        'status',
        'categoryId',
        'brandId',
      ])
    ) {
      return false;
    }
    if (where.barcodes?.some?.value !== undefined) {
      const wanted = where.barcodes.some.value as string;
      if (
        !store.barcodes.some(
          (barcode) =>
            barcode.productId === product.id && barcode.value === wanted,
        )
      ) {
        return false;
      }
    }
    if (Array.isArray(where.OR)) {
      const matchesOr = where.OR.some((clause: Where) => {
        if (clause.name?.contains) {
          return String(product.name)
            .toLowerCase()
            .includes(String(clause.name.contains).toLowerCase());
        }
        if (clause.sku?.contains) {
          return String(product.sku)
            .toLowerCase()
            .includes(String(clause.sku.contains).toLowerCase());
        }
        return false;
      });
      if (!matchesOr) {
        return false;
      }
    }
    return true;
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
      findFirst: async ({ where }: { where: Where }) =>
        locations.find(
          (candidate) =>
            candidate.id === where.id && candidate.tenantId === where.tenantId,
        ) ?? null,
    },
    productCategory: {
      create: async ({ data }: { data: Where }) => {
        if (
          store.categories.some(
            (row) => row.tenantId === data.tenantId && row.name === data.name,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = withTimestamps({
          id: nextId('cat'),
          description: null,
          parentId: null,
          ...stripUndefined(data),
        }) as Row;
        store.categories.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.categories.find((row) =>
          matchScalar(row, where, ['id', 'tenantId']),
        ) ?? null,
      findMany: async ({ where }: { where: Where }) =>
        store.categories
          .filter((row) => matchScalar(row, where, ['tenantId']))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.categories.find(
          (candidate) => candidate.id === where.id,
        )!;
        if (
          data.name !== undefined &&
          store.categories.some(
            (other) =>
              other.id !== row.id &&
              other.tenantId === row.tenantId &&
              other.name === data.name,
          )
        ) {
          throw { code: 'P2002' };
        }
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.categories.find(
          (candidate) => candidate.id === where.id,
        )!;
        const referenced =
          store.products.some((product) => product.categoryId === row.id) ||
          store.categories.some((child) => child.parentId === row.id);
        if (referenced) {
          throw { code: 'P2003' };
        }
        store.categories = store.categories.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
    },
    brand: {
      create: async ({ data }: { data: Where }) => {
        if (
          store.brands.some(
            (row) => row.tenantId === data.tenantId && row.name === data.name,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = withTimestamps({
          id: nextId('brand'),
          description: null,
          ...stripUndefined(data),
        }) as Row;
        store.brands.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.brands.find((row) =>
          matchScalar(row, where, ['id', 'tenantId']),
        ) ?? null,
      findMany: async ({ where }: { where: Where }) =>
        store.brands.filter((row) => matchScalar(row, where, ['tenantId'])),
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.brands.find(
          (candidate) => candidate.id === where.id,
        )!;
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.brands.find(
          (candidate) => candidate.id === where.id,
        )!;
        if (store.products.some((product) => product.brandId === row.id)) {
          throw { code: 'P2003' };
        }
        store.brands = store.brands.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
    },
    product: {
      create: async ({ data }: { data: Where }) => {
        if (
          store.products.some(
            (row) => row.tenantId === data.tenantId && row.sku === data.sku,
          )
        ) {
          throw { code: 'P2002' };
        }
        const { barcodes, ...productData } = data;
        const row = withTimestamps({
          id: nextId('prod'),
          description: null,
          categoryId: null,
          brandId: null,
          unitOfMeasure: 'EACH',
          status: 'DRAFT',
          lowStockThreshold: null,
          ...stripUndefined(productData),
        }) as Row;
        for (const barcode of barcodes?.create ?? []) {
          if (
            store.barcodes.some(
              (existing) =>
                existing.tenantId === barcode.tenantId &&
                existing.value === barcode.value,
            )
          ) {
            throw { code: 'P2002' };
          }
          store.barcodes.push(
            withTimestamps({
              id: nextId('bc'),
              format: 'OTHER',
              productId: row.id,
              ...stripUndefined(barcode),
            }) as Row,
          );
        }
        store.products.push(row);
        return productWithInclude(row);
      },
      findFirst: async ({ where }: { where: Where }) => {
        const row = store.products.find((candidate) =>
          matchesProduct(candidate, where),
        );
        return row ? productWithInclude(row) : null;
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
        store.products
          .filter((row) => matchesProduct(row, where))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 25))
          .map(productWithInclude),
      count: async ({ where }: { where: Where }) =>
        store.products.filter((row) => matchesProduct(row, where)).length,
      update: async ({ where, data }: { where: Where; data: Where }) => {
        const row = store.products.find(
          (candidate) => candidate.id === where.id,
        )!;
        Object.assign(row, data);
        return productWithInclude(row);
      },
      delete: async ({ where }: { where: Where }) => {
        const row = store.products.find(
          (candidate) => candidate.id === where.id,
        )!;
        const referenced =
          store.levels.some((level) => level.productId === row.id) ||
          store.movements.some((movement) => movement.productId === row.id);
        if (referenced) {
          throw { code: 'P2003' };
        }
        store.products = store.products.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
    },
    productBarcode: {
      create: async ({ data }: { data: Where }) => {
        if (
          store.barcodes.some(
            (row) => row.tenantId === data.tenantId && row.value === data.value,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row = withTimestamps({
          id: nextId('bc'),
          format: 'OTHER',
          ...stripUndefined(data),
        }) as Row;
        store.barcodes.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Where }) =>
        store.barcodes.find((row) =>
          matchScalar(row, where, ['id', 'productId', 'tenantId']),
        ) ?? null,
      delete: async ({ where }: { where: Where }) => {
        const row = store.barcodes.find(
          (candidate) => candidate.id === where.id,
        )!;
        store.barcodes = store.barcodes.filter(
          (candidate) => candidate.id !== row.id,
        );
        return row;
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const before = store.barcodes.length;
        store.barcodes = store.barcodes.filter(
          (row) =>
            !(row.productId === where.productId && row.tenantId === where.tenantId),
        );
        return { count: before - store.barcodes.length };
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
        const row = withTimestamps({
          id: nextId('level'),
          quantity: 0,
          ...stripUndefined(create),
        }) as Row & { quantity: number };
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
            candidate.quantity >= (where.quantity?.gte ?? 0),
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
      findMany: async ({ where }: { where: Where }) =>
        store.levels
          .filter((row) =>
            matchScalar(row, where, ['tenantId', 'locationId', 'productId']),
          )
          .map((row) => ({
            ...row,
            product: (() => {
              const product = store.products.find(
                (candidate) => candidate.id === row.productId,
              )!;
              return {
                id: product.id,
                sku: product.sku,
                name: product.name,
                status: product.status,
                unitOfMeasure: product.unitOfMeasure,
                lowStockThreshold: product.lowStockThreshold,
              };
            })(),
            location: (() => {
              const location = locations.find(
                (candidate) => candidate.id === row.locationId,
              )!;
              return {
                id: location.id,
                name: location.name,
                code: location.code,
              };
            })(),
          })),
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
      findMany: async ({
        where,
        skip,
        take,
      }: {
        where: Where;
        skip?: number;
        take?: number;
      }) =>
        store.movements
          .filter((row) =>
            matchScalar(row, where, ['tenantId', 'locationId', 'productId']),
          )
          .slice()
          .reverse()
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 50)),
      count: async ({ where }: { where: Where }) =>
        store.movements.filter((row) =>
          matchScalar(row, where, ['tenantId', 'locationId', 'productId']),
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

  describe('catalog CRUD & RBAC', () => {
    let categoryId: string;
    let brandId: string;
    let productId: string;
    let barcodeId: string;

    it('unauthenticated requests are rejected', async () => {
      await request(app.getHttpServer()).get('/catalog/products').expect(401);
    });

    it('platform users are rejected from tenant catalog endpoints', async () => {
      await request(app.getHttpServer())
        .get('/catalog/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });

    it('a viewer WITHOUT catalog:manage cannot create; denial is audited', async () => {
      await request(app.getHttpServer())
        .post('/catalog/categories')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ name: 'Sneaky' })
        .expect(403);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ACCESS_DENIED' }),
        }),
      );
      expect(store.categories.some((c) => c.name === 'Sneaky')).toBe(false);
    });

    it('a manager creates a category; the tenantId comes from the token', async () => {
      const response = await request(app.getHttpServer())
        .post('/catalog/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Beverages' })
        .expect(201);
      categoryId = response.body.id;
      expect(response.body.tenantId).toBe('tenant-a');
      // Audited atomically with the write.
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entityType: 'ProductCategory',
            tenantId: 'tenant-a',
            actorId: 'manager-a',
          }),
        }),
      );
    });

    it('duplicate category names conflict (409)', async () => {
      await request(app.getHttpServer())
        .post('/catalog/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Beverages' })
        .expect(409);
    });

    it('a tenantId in the body is rejected outright (400)', async () => {
      await request(app.getHttpServer())
        .post('/catalog/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Evil', tenantId: 'tenant-b' })
        .expect(400);
    });

    it('another tenant’s category cannot be used as a parent', async () => {
      await request(app.getHttpServer())
        .post('/catalog/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Nested', parentId: 'cat-b' })
        .expect(400);
    });

    it('a manager creates a brand and a product with a barcode', async () => {
      const brandResponse = await request(app.getHttpServer())
        .post('/catalog/brands')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Acme Beverages' })
        .expect(201);
      brandId = brandResponse.body.id;

      const productResponse = await request(app.getHttpServer())
        .post('/catalog/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          sku: 'bev-cola-330',
          name: 'Cola 330ml Can',
          categoryId,
          brandId,
          lowStockThreshold: 8,
          barcodes: [{ value: '4006381333931', format: 'EAN13' }],
        })
        .expect(201);
      productId = productResponse.body.id;
      expect(productResponse.body.sku).toBe('BEV-COLA-330');
      expect(productResponse.body.tenantId).toBe('tenant-a');
      expect(productResponse.body.barcodes).toHaveLength(1);
      expect(productResponse.body.category.name).toBe('Beverages');
    });

    it('search finds by name fragment, SKU, barcode, and status', async () => {
      const byName = await request(app.getHttpServer())
        .get('/catalog/products?search=cola')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(byName.body.total).toBe(1);
      expect(byName.body.items[0].id).toBe(productId);

      const byBarcode = await request(app.getHttpServer())
        .get('/catalog/products?barcode=4006381333931')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(byBarcode.body.total).toBe(1);

      const byStatus = await request(app.getHttpServer())
        .get('/catalog/products?status=ACTIVE')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(byStatus.body.total).toBe(0);
    });

    it('search NEVER leaks another tenant’s products', async () => {
      // "Tenant B Cola" matches the fragment but belongs to tenant-b.
      const response = await request(app.getHttpServer())
        .get('/catalog/products?search=cola')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(
        response.body.items.every(
          (item: { tenantId: string }) => item.tenantId === 'tenant-a',
        ),
      ).toBe(true);
      await request(app.getHttpServer())
        .get('/catalog/products?barcode=BARCODE-B')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200)
        .expect((res) => expect(res.body.total).toBe(0));
    });

    it('cross-tenant reads and writes miss with 404', async () => {
      await request(app.getHttpServer())
        .get('/catalog/products/prod-b')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch('/catalog/products/prod-b')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: 'Hijacked' })
        .expect(404);
      expect(
        store.products.find((p) => p.id === 'prod-b')?.name,
      ).toBe('Tenant B Cola');
    });

    it('updates a product and audits before/after', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(response.body.status).toBe('ACTIVE');
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPDATE',
            entityType: 'Product',
            entityId: productId,
          }),
        }),
      );
    });

    it('rejects an explicit null for non-nullable product enums (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ unitOfMeasure: null })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/catalog/products/${productId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: null })
        .expect(400);
    });

    it('rejects an explicit null brand description instead of 500ing (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/catalog/brands/${brandId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ description: null })
        .expect(400);
    });

    it('rejects a lowStockThreshold beyond the INT range (400)', async () => {
      await request(app.getHttpServer())
        .post('/catalog/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          sku: 'OVERFLOW-1',
          name: 'Overflow',
          lowStockThreshold: 2147483648,
        })
        .expect(400);
    });

    it('adds and removes barcodes via the sub-endpoints', async () => {
      const added = await request(app.getHttpServer())
        .post(`/catalog/products/${productId}/barcodes`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ value: '5000112637922', format: 'EAN13' })
        .expect(201);
      barcodeId = added.body.id;

      // The same value cannot be assigned twice within the tenant.
      await request(app.getHttpServer())
        .post(`/catalog/products/${productId}/barcodes`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ value: '5000112637922' })
        .expect(409);

      await request(app.getHttpServer())
        .delete(`/catalog/products/${productId}/barcodes/${barcodeId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(204);
    });

    it('deleting a category still referenced by products conflicts (409)', async () => {
      await request(app.getHttpServer())
        .delete(`/catalog/categories/${categoryId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(409);
    });
  });

  describe('inventory adjustments & ledger', () => {
    let productId: string;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .post('/catalog/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          sku: 'STK-TEST-1',
          name: 'Stock Test Item',
          status: 'ACTIVE',
          lowStockThreshold: 8,
        })
        .expect(201);
      productId = response.body.id;
    });

    it('a viewer WITHOUT inventory:adjust cannot adjust stock', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: 5,
          reason: 'sneaky',
        })
        .expect(403);
      expect(store.movements).toHaveLength(0);
    });

    it('a tenantId in the adjustment body is rejected outright (400)', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          tenantId: 'tenant-b',
          locationId: 'loc-a1',
          productId,
          quantityDelta: 5,
          reason: 'override attempt',
        })
        .expect(400);
      expect(store.movements).toHaveLength(0);
    });

    it('zero deltas are rejected at validation time', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: 0,
          reason: 'no-op',
        })
        .expect(400);
    });

    it('rejects a delta outside the persisted integer range (400)', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: 2147483648,
          reason: 'overflow attempt',
        })
        .expect(400);
      expect(store.movements).toHaveLength(0);
    });

    it('an adjustment appends an immutable movement, updates the level, and audits', async () => {
      const response = await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: 10,
          reason: 'Initial stock load',
        })
        .expect(201);

      expect(response.body.level.quantity).toBe(10);
      expect(response.body.movement).toEqual(
        expect.objectContaining({
          movementType: 'ADJUSTMENT',
          quantityDelta: 10,
          quantityAfter: 10,
          reason: 'Initial stock load',
          createdById: 'manager-a',
          tenantId: 'tenant-a',
        }),
      );
      expect(store.movements).toHaveLength(1);
      expect(auditCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'STOCK_ADJUSTMENT',
            entityType: 'InventoryMovement',
            tenantId: 'tenant-a',
            actorId: 'manager-a',
            reason: 'Initial stock load',
          }),
        }),
      );
    });

    it('a second adjustment builds on the projected level', async () => {
      const response = await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: -4,
          reason: 'Damaged cans',
        })
        .expect(201);
      expect(response.body.level.quantity).toBe(6);
      expect(response.body.movement.quantityAfter).toBe(6);
      expect(store.movements).toHaveLength(2);
    });

    it('an adjustment below zero is rejected and appends NOTHING', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: -100,
          reason: 'Impossible',
        })
        .expect(409);
      expect(store.movements).toHaveLength(2);
      expect(
        store.levels.find((level) => level.productId === productId)?.quantity,
      ).toBe(6);
    });

    it('another tenant’s location or product 404s — no cross-tenant stock moves', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-b1',
          productId,
          quantityDelta: 1,
          reason: 'wrong location',
        })
        .expect(404);
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          locationId: 'loc-a1',
          productId: 'prod-b',
          quantityDelta: 1,
          reason: 'foreign product',
        })
        .expect(404);
      expect(store.movements).toHaveLength(2);
    });

    it('levels report low stock from the product threshold', async () => {
      const response = await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      const level = response.body.find(
        (row: { productId: string }) => row.productId === productId,
      );
      // quantity 6 <= threshold 8.
      expect(level.quantity).toBe(6);
      expect(level.isLowStock).toBe(true);
      expect(level.product.sku).toBe('STK-TEST-1');

      const lowOnly = await request(app.getHttpServer())
        .get('/inventory/levels?lowStockOnly=true')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      expect(
        lowOnly.body.every((row: { isLowStock: boolean }) => row.isLowStock),
      ).toBe(true);
    });

    it('rejects an ambiguous lowStockOnly value like "1" (400)', async () => {
      // Only 'true'/'false' are accepted, so '1' is a validation error rather
      // than being silently treated as false and returning all levels.
      await request(app.getHttpServer())
        .get('/inventory/levels?lowStockOnly=1')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(400);
    });

    it('the ledger lists this tenant’s movements newest first', async () => {
      // Cross-tenant bait: a movement for tenant-b must never appear.
      store.movements.push({
        id: 'move-b',
        tenantId: 'tenant-b',
        locationId: 'loc-b1',
        productId: 'prod-b',
        movementType: 'ADJUSTMENT',
        quantityDelta: 5,
        quantityAfter: 5,
        reason: 'foreign',
      } as Row);

      const response = await request(app.getHttpServer())
        .get('/inventory/movements')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      expect(response.body.total).toBe(2);
      expect(response.body.items[0].quantityDelta).toBe(-4);
      expect(response.body.items[1].quantityDelta).toBe(10);
      expect(
        response.body.items.every(
          (item: { tenantId: string }) => item.tenantId === 'tenant-a',
        ),
      ).toBe(true);
    });

    it('viewers can read but the adjust permission stays enforced end-to-end', async () => {
      await request(app.getHttpServer())
        .get('/inventory/movements')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          locationId: 'loc-a1',
          productId,
          quantityDelta: 1,
          reason: 'still sneaky',
        })
        .expect(403);
    });

    it('platform users are rejected from inventory endpoints', async () => {
      await request(app.getHttpServer())
        .get('/inventory/levels')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });
  });

  describe('module enablement gate', () => {
    // Temporarily flip tenant A's inventory module to DISABLED and prove that
    // catalog AND inventory routes are blocked (403) even for a manager who
    // holds catalog:*/inventory:* — RBAC alone is not enough. Restored after.
    async function withInventoryDisabled(run: () => Promise<void>) {
      const previous = tenantModules[0].status;
      tenantModules[0].status = 'DISABLED';
      try {
        await run();
      } finally {
        tenantModules[0].status = previous;
      }
    }

    it('blocks catalog routes when the inventory module is not enabled', async () => {
      await withInventoryDisabled(async () => {
        await request(app.getHttpServer())
          .get('/catalog/products')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
      });
    });

    it('blocks inventory routes when the inventory module is not enabled', async () => {
      await withInventoryDisabled(async () => {
        await request(app.getHttpServer())
          .get('/inventory/levels')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
        await request(app.getHttpServer())
          .post('/inventory/adjustments')
          .set('Authorization', `Bearer ${managerToken}`)
          .send({
            locationId: 'loc-a1',
            productId: 'prod-x',
            quantityDelta: 1,
            reason: 'blocked by module gate',
          })
          .expect(403);
      });
    });

    it('the denial is audited as ACCESS_DENIED', async () => {
      await withInventoryDisabled(async () => {
        auditCreateSpy.mockClear();
        await request(app.getHttpServer())
          .get('/catalog/products')
          .set('Authorization', `Bearer ${managerToken}`)
          .expect(403);
        expect(auditCreateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ action: 'ACCESS_DENIED' }),
          }),
        );
      });
    });

    it('admits the routes again once the module is enabled', async () => {
      await request(app.getHttpServer())
        .get('/catalog/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
    });
  });
});
