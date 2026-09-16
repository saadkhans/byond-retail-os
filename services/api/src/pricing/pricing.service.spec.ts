import { ConflictException, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PriceActivationHub } from './price-activation.hub';
import { PriceResolutionService } from './price-resolution.service';
import { PricingRepository } from './pricing.repository';
import { PricingService } from './pricing.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ACTOR = { id: 'user-1', email: 'ops@example.com' };

type Row = Record<string, unknown>;

/**
 * In-memory stub over the three pricing tables plus read-only location and
 * product fixtures. Rich enough to prove the invariants that matter: versions
 * are appended, activation supersedes, rollback copies forward, and nothing
 * ever reads across tenants.
 */
function buildHarness() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const books: Row[] = [];
  const versions: Row[] = [];
  const entries: Row[] = [];
  const audits: Row[] = [];
  const locations = [
    { id: 'store-1', tenantId: TENANT },
    { id: 'store-9', tenantId: OTHER_TENANT },
  ];
  const products = [
    { id: 'prod-a', tenantId: TENANT },
    { id: 'prod-b', tenantId: TENANT },
    { id: 'prod-foreign', tenantId: OTHER_TENANT },
  ];

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond !== null && typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        if ('in' in c) {
          return (c.in as unknown[]).includes(row[key]);
        }
        if ('lte' in c) {
          return (row[key] as Date).getTime() <= (c.lte as Date).getTime();
        }
        if ('gt' in c) {
          return (
            row[key] !== null &&
            (row[key] as Date).getTime() > (c.gt as Date).getTime()
          );
        }
      }
      return row[key] === cond;
    });

  const table = (rows: Row[], prefix: string, defaults: Row = {}) => ({
    findFirst: jest.fn(async (args: { where: Row }) => {
      const hit = rows.find((row) => matches(row, args.where));
      return hit ? { ...hit } : null;
    }),
    findMany: jest.fn(async (args: { where?: Row } = {}) =>
      rows.filter((row) => matches(row, args.where ?? {})).map((row) => ({ ...row })),
    ),
    count: jest.fn(async (args: { where: Row }) =>
      rows.filter((row) => matches(row, args.where)).length,
    ),
    aggregate: jest.fn(async (args: { where: Row }) => {
      const hits = rows.filter((row) => matches(row, args.where));
      const max = hits.reduce(
        (highest, row) => Math.max(highest, (row.versionNumber as number) ?? 0),
        0,
      );
      return { _max: { versionNumber: hits.length === 0 ? null : max } };
    }),
    create: jest.fn(async (args: { data: Row }) => {
      const row = { id: nextId(prefix), ...defaults, ...args.data };
      rows.push(row);
      return { ...row };
    }),
    createMany: jest.fn(async (args: { data: Row[] }) => {
      for (const data of args.data) {
        rows.push({ id: nextId(prefix), ...defaults, ...data });
      }
      return { count: args.data.length };
    }),
    // Destructive writes carry the tenant IN the write predicate via the
    // `id_tenantId` composite key; the fake resolves either form and
    // misses on a tenant mismatch, exactly as Postgres would.
    update: jest.fn(
      async (args: {
        where: { id?: string; id_tenantId?: { id: string; tenantId: string } };
        data: Row;
      }) => {
        const key = args.where.id_tenantId ?? { id: args.where.id };
        const row = rows.find(
          (candidate) =>
            candidate.id === key.id &&
            (!("tenantId" in key) || candidate.tenantId === key.tenantId),
        );
        if (!row) {
          throw new Error(`no ${prefix} ${key.id}`);
        }
        for (const [field, value] of Object.entries(args.data)) {
          if (value !== undefined) {
            row[field] = value;
          }
        }
        return { ...row };
      },
    ),
    deleteMany: jest.fn(async (args: { where: Row }) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index], args.where)) {
          rows.splice(index, 1);
        }
      }
      return { count: 0 };
    }),
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    location: {
      findFirst: jest.fn(async (args: { where: Row }) => {
        const hit = locations.find((row) => matches(row as never, args.where));
        return hit ? { id: hit.id } : null;
      }),
    },
    product: {
      count: jest.fn(async (args: { where: Row }) =>
        products.filter((row) => matches(row as never, args.where)).length,
      ),
    },
    priceBook: table(books, 'book', {
      status: 'ACTIVE',
      locationId: null,
      createdAt: new Date('2026-09-16T09:00:00Z'),
      updatedAt: new Date('2026-09-16T09:00:00Z'),
    }),
    priceBookVersion: table(versions, 'version', {
      status: 'DRAFT',
      effectiveTo: null,
      note: null,
      activatedAt: null,
      activatedById: null,
      supersededByVersionId: null,
      rolledBackFromVersionId: null,
      createdAt: new Date('2026-09-16T09:00:00Z'),
      updatedAt: new Date('2026-09-16T09:00:00Z'),
    }),
    priceBookEntry: table(entries, 'entry', {
      createdAt: new Date('2026-09-16T09:00:00Z'),
    }),
    auditLog: {
      create: jest.fn(async (args: { data: Row }) => {
        audits.push(args.data);
        return args.data;
      }),
    },
  };
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  // createVersion(copyFrom) and rollback both read a version WITH its
  // entries, so the stub has to honour that one nested select.
  const plainVersionFindFirst = prisma.priceBookVersion.findFirst;
  prisma.priceBookVersion.findFirst = jest.fn(
    async (args: { where: Row; select?: Row }) => {
      const row = await plainVersionFindFirst(args);
      if (!row || !args.select || !('entries' in args.select)) {
        return row;
      }
      return {
        ...row,
        entries: entries
          .filter((entry) => entry.versionId === row.id)
          .map((entry) => ({ ...entry })),
      };
    },
  );
  // The entry table's findMany needs relation-aware filtering for resolution;
  // the resolver's query nests version/priceBook conditions, so flatten it.
  prisma.priceBookEntry.findMany = jest.fn(
    async (args: { where: Row } = { where: {} }) => {
      const where = args.where ?? {};
      const versionWhere = (where.version ?? {}) as Row;
      const bookWhere = (versionWhere.priceBook ?? {}) as Row;
      const versionOr = (versionWhere.OR ?? []) as Row[];
      const bookOr = (bookWhere.OR ?? []) as Row[];
      const flatEntryWhere = { ...where };
      delete flatEntryWhere.version;
      return entries
        .filter((entry) => matches(entry, flatEntryWhere))
        .map((entry) => ({
          entry,
          version: versions.find((v) => v.id === entry.versionId) as Row,
        }))
        .filter(({ version }) => {
          if (!version) {
            return false;
          }
          const flatVersionWhere = { ...versionWhere };
          delete flatVersionWhere.priceBook;
          delete flatVersionWhere.OR;
          if (!matches(version, flatVersionWhere)) {
            return false;
          }
          if (versionOr.length > 0 && !versionOr.some((cond) => matches(version, cond))) {
            return false;
          }
          const book = books.find((b) => b.id === version.priceBookId) as Row;
          const flatBookWhere = { ...bookWhere };
          delete flatBookWhere.OR;
          if (!book || !matches(book, flatBookWhere)) {
            return false;
          }
          if (bookOr.length > 0 && !bookOr.some((cond) => matches(book, cond))) {
            return false;
          }
          return true;
        })
        .map(({ entry, version }) => {
          const book = books.find((b) => b.id === version.priceBookId) as Row;
          return {
            productId: entry.productId,
            unitPriceMinor: entry.unitPriceMinor,
            currencyCode: entry.currencyCode,
            version: {
              id: version.id,
              versionNumber: version.versionNumber,
              status: version.status,
              effectiveFrom: version.effectiveFrom,
              effectiveTo: version.effectiveTo,
              priceBook: {
                id: book.id,
                code: book.code,
                locationId: book.locationId,
              },
            },
          };
        });
    },
  );

  const repository = new PricingRepository(
    prisma as PrismaService,
    new AuditLogService(prisma as PrismaService),
  );
  const platformModules = {
    isEnabledForTenant: jest.fn(async () => true),
  } as unknown as PlatformModulesService;
  const resolution = new PriceResolutionService(repository, platformModules);
  const activationHub = new PriceActivationHub();
  const service = new PricingService(repository, resolution, activationHub);
  return {
    service,
    resolution,
    repository,
    platformModules,
    activationHub,
    books,
    versions,
    entries,
    audits,
    prisma,
  };
}

async function activeBookWithPrice(
  harness: ReturnType<typeof buildHarness>,
  unitPriceMinor: number,
) {
  const book = await harness.service.createBook(
    TENANT,
    { code: 'retail', name: 'Retail', currencyCode: 'aed' },
    ACTOR,
  );
  const version = await harness.service.createVersion(
    TENANT,
    book.id,
    { reason: 'INITIAL' },
    ACTOR,
  );
  await harness.service.setEntries(
    TENANT,
    book.id,
    version.id,
    { entries: [{ productId: 'prod-a', unitPriceMinor }] },
    ACTOR,
  );
  const activated = await harness.service.activateVersion(
    TENANT,
    book.id,
    version.id,
    { effectiveFrom: '2026-01-01T00:00:00Z' },
    ACTOR,
  );
  return { book, version: activated };
}

describe('PricingService — books', () => {
  it('normalizes the code and currency on create', async () => {
    const harness = buildHarness();
    const book = await harness.service.createBook(
      TENANT,
      { code: ' retail-01 ', name: 'Retail', currencyCode: 'aed' },
      ACTOR,
    );
    expect(book.code).toBe('RETAIL-01');
    expect(book.currencyCode).toBe('AED');
  });

  it('rejects a duplicate code within the tenant', async () => {
    const harness = buildHarness();
    await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    await expect(
      harness.service.createBook(
        TENANT,
        { code: 'retail', name: 'Other', currencyCode: 'AED' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets a different tenant reuse the same code', async () => {
    const harness = buildHarness();
    await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    await expect(
      harness.service.createBook(
        OTHER_TENANT,
        { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
        ACTOR,
      ),
    ).resolves.toMatchObject({ code: 'RETAIL' });
  });

  it('rejects a location from another tenant', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.createBook(
        TENANT,
        {
          code: 'STORE',
          name: 'Store',
          currencyCode: 'AED',
          locationId: 'store-9',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('audits creation', async () => {
    const harness = buildHarness();
    await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    expect(harness.audits).toContainEqual(
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'PriceBook',
        tenantId: TENANT,
        actorEmail: ACTOR.email,
      }),
    );
  });
});

describe('PricingService — version invariants', () => {
  it('numbers versions monotonically per book', async () => {
    const harness = buildHarness();
    const book = await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    const first = await harness.service.createVersion(
      TENANT,
      book.id,
      {},
      ACTOR,
    );
    const second = await harness.service.createVersion(
      TENANT,
      book.id,
      {},
      ACTOR,
    );
    expect(first.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(2);
  });

  it('freezes entries once a version has been activated', async () => {
    const harness = buildHarness();
    const { book, version } = await activeBookWithPrice(harness, 1000);
    await expect(
      harness.service.setEntries(
        TENANT,
        book.id,
        version.id,
        { entries: [{ productId: 'prod-a', unitPriceMinor: 1 }] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // The activated prices are untouched.
    expect(
      harness.entries.filter((entry) => entry.versionId === version.id),
    ).toEqual([expect.objectContaining({ unitPriceMinor: 1000 })]);
  });

  it('refuses to activate an empty version', async () => {
    const harness = buildHarness();
    const book = await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    const version = await harness.service.createVersion(
      TENANT,
      book.id,
      {},
      ACTOR,
    );
    await expect(
      harness.service.activateVersion(TENANT, book.id, version.id, {}, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to activate a version twice', async () => {
    const harness = buildHarness();
    const { book, version } = await activeBookWithPrice(harness, 1000);
    await expect(
      harness.service.activateVersion(TENANT, book.id, version.id, {}, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('supersedes the previous version instead of deleting it', async () => {
    const harness = buildHarness();
    const { book, version: first } = await activeBookWithPrice(harness, 1000);
    const second = await harness.service.createVersion(
      TENANT,
      book.id,
      { reason: 'PRICE_CHANGE' },
      ACTOR,
    );
    await harness.service.setEntries(
      TENANT,
      book.id,
      second.id,
      { entries: [{ productId: 'prod-a', unitPriceMinor: 1200 }] },
      ACTOR,
    );
    await harness.service.activateVersion(
      TENANT,
      book.id,
      second.id,
      { effectiveFrom: '2026-06-01T00:00:00Z' },
      ACTOR,
    );
    const stored = harness.versions.find((row) => row.id === first.id);
    expect(stored).toMatchObject({
      status: 'SUPERSEDED',
      supersededByVersionId: second.id,
      effectiveTo: new Date('2026-06-01T00:00:00Z'),
    });
    // The old row is still there, with its original prices.
    expect(harness.versions).toHaveLength(2);
    expect(
      harness.entries.filter((entry) => entry.versionId === first.id),
    ).toHaveLength(1);
  });

  it('refuses an effective date that would invert the windows', async () => {
    const harness = buildHarness();
    const { book } = await activeBookWithPrice(harness, 1000);
    const second = await harness.service.createVersion(TENANT, book.id, {}, ACTOR);
    await harness.service.setEntries(
      TENANT,
      book.id,
      second.id,
      { entries: [{ productId: 'prod-a', unitPriceMinor: 1200 }] },
      ACTOR,
    );
    await expect(
      harness.service.activateVersion(
        TENANT,
        book.id,
        second.id,
        { effectiveFrom: '2025-01-01T00:00:00Z' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('audits activation as a price change', async () => {
    const harness = buildHarness();
    await activeBookWithPrice(harness, 1000);
    expect(harness.audits).toContainEqual(
      expect.objectContaining({
        action: 'PRICE_CHANGE',
        entityType: 'PriceBookVersion',
        tenantId: TENANT,
      }),
    );
  });

  it('rejects a note carrying payment-bearing text', async () => {
    const harness = buildHarness();
    const book = await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    await expect(
      harness.service.createVersion(
        TENANT,
        book.id,
        { note: 'card 4111 1111 1111 1111' },
        ACTOR,
      ),
    ).rejects.toThrow(/credential- or payment-bearing/);
  });

  it('rejects an entry set naming the same product twice', async () => {
    const harness = buildHarness();
    const book = await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    const version = await harness.service.createVersion(TENANT, book.id, {}, ACTOR);
    await expect(
      harness.service.setEntries(
        TENANT,
        book.id,
        version.id,
        {
          entries: [
            { productId: 'prod-a', unitPriceMinor: 100 },
            { productId: 'prod-a', unitPriceMinor: 200 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toThrow(/at most once/);
  });

  it('rejects an entry naming a product from another tenant', async () => {
    const harness = buildHarness();
    const book = await harness.service.createBook(
      TENANT,
      { code: 'RETAIL', name: 'Retail', currencyCode: 'AED' },
      ACTOR,
    );
    const version = await harness.service.createVersion(TENANT, book.id, {}, ACTOR);
    await expect(
      harness.service.setEntries(
        TENANT,
        book.id,
        version.id,
        { entries: [{ productId: 'prod-foreign', unitPriceMinor: 100 }] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PricingService — rollback', () => {
  it('creates a NEW version carrying the old prices and activates it', async () => {
    const harness = buildHarness();
    const { book, version: first } = await activeBookWithPrice(harness, 1000);
    const second = await harness.service.createVersion(TENANT, book.id, {}, ACTOR);
    await harness.service.setEntries(
      TENANT,
      book.id,
      second.id,
      { entries: [{ productId: 'prod-a', unitPriceMinor: 9999 }] },
      ACTOR,
    );
    await harness.service.activateVersion(
      TENANT,
      book.id,
      second.id,
      { effectiveFrom: '2026-06-01T00:00:00Z' },
      ACTOR,
    );

    const restored = await harness.service.rollbackToVersion(
      TENANT,
      book.id,
      first.id,
      { note: 'bad price' },
      ACTOR,
    );

    expect(restored.id).not.toBe(first.id);
    expect(restored.versionNumber).toBe(3);
    expect(restored.status).toBe('ACTIVE');
    expect(restored.rolledBackFromVersionId).toBe(first.id);
    expect(
      harness.entries.filter((entry) => entry.versionId === restored.id),
    ).toEqual([expect.objectContaining({ unitPriceMinor: 1000 })]);
    // The version it restored is untouched, and the bad one is superseded.
    expect(harness.versions.find((row) => row.id === first.id)).toMatchObject({
      status: 'SUPERSEDED',
    });
    expect(harness.versions.find((row) => row.id === second.id)).toMatchObject({
      status: 'SUPERSEDED',
      supersededByVersionId: restored.id,
    });
  });

  it('refuses to roll back to a version that was never active', async () => {
    const harness = buildHarness();
    const { book } = await activeBookWithPrice(harness, 1000);
    const draft = await harness.service.createVersion(TENANT, book.id, {}, ACTOR);
    await harness.service.setEntries(
      TENANT,
      book.id,
      draft.id,
      { entries: [{ productId: 'prod-a', unitPriceMinor: 5 }] },
      ACTOR,
    );
    await expect(
      harness.service.rollbackToVersion(TENANT, book.id, draft.id, {}, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('audits the rollback', async () => {
    const harness = buildHarness();
    const { book, version } = await activeBookWithPrice(harness, 1000);
    const second = await harness.service.createVersion(TENANT, book.id, {}, ACTOR);
    await harness.service.setEntries(
      TENANT,
      book.id,
      second.id,
      { entries: [{ productId: 'prod-a', unitPriceMinor: 2000 }] },
      ACTOR,
    );
    await harness.service.activateVersion(
      TENANT,
      book.id,
      second.id,
      { effectiveFrom: '2026-06-01T00:00:00Z' },
      ACTOR,
    );
    await harness.service.rollbackToVersion(TENANT, book.id, version.id, {}, ACTOR);
    expect(harness.audits).toContainEqual(
      expect.objectContaining({ action: 'ROLLBACK' }),
    );
  });
});

describe('PricingService — tenant isolation', () => {
  it('never reads another tenant’s book', async () => {
    const harness = buildHarness();
    const { book } = await activeBookWithPrice(harness, 1000);
    await expect(
      harness.service.findBookById(OTHER_TENANT, book.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    const listed = await harness.service.findBooks(OTHER_TENANT, {});
    expect(listed.items).toHaveLength(0);
  });

  it('never mutates another tenant’s version', async () => {
    const harness = buildHarness();
    const { book, version } = await activeBookWithPrice(harness, 1000);
    await expect(
      harness.service.rollbackToVersion(OTHER_TENANT, book.id, version.id, {}, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      harness.service.updateBook(OTHER_TENANT, book.id, { name: 'X' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never resolves a price across tenants', async () => {
    const harness = buildHarness();
    await activeBookWithPrice(harness, 1000);
    await expect(
      harness.service.resolve(OTHER_TENANT, { productId: 'prod-a' }),
    ).resolves.toBeNull();
  });

  it('refuses an empty tenant id rather than reading every tenant', async () => {
    const harness = buildHarness();
    await expect(harness.service.findBooks('', {})).rejects.toThrow();
  });
});

describe('PriceResolutionService', () => {
  it('resolves the active price', async () => {
    const harness = buildHarness();
    await activeBookWithPrice(harness, 1000);
    await expect(
      harness.resolution.resolve(TENANT, 'prod-a', new Date('2026-09-16T00:00:00Z')),
    ).resolves.toMatchObject({ unitPriceMinor: 1000, currencyCode: 'AED' });
  });

  it('returns null for a product no book covers', async () => {
    const harness = buildHarness();
    await activeBookWithPrice(harness, 1000);
    await expect(
      harness.resolution.resolve(TENANT, 'prod-b'),
    ).resolves.toBeNull();
  });

  it('returns null for checkout when the tenant has pricing disabled', async () => {
    const harness = buildHarness();
    await activeBookWithPrice(harness, 1000);
    (harness.platformModules.isEnabledForTenant as jest.Mock).mockResolvedValue(
      false,
    );
    await expect(
      harness.resolution.resolveForLine(harness.prisma, {
        tenantId: TENANT,
        productId: 'prod-a',
        locationId: 'store-1',
        at: new Date('2026-09-16T00:00:00Z'),
      }),
    ).resolves.toBeNull();
  });

  it('resolves for checkout when the module is enabled', async () => {
    const harness = buildHarness();
    await activeBookWithPrice(harness, 1000);
    await expect(
      harness.resolution.resolveForLine(harness.prisma, {
        tenantId: TENANT,
        productId: 'prod-a',
        locationId: 'store-1',
        at: new Date('2026-09-16T00:00:00Z'),
      }),
    ).resolves.toMatchObject({ unitPriceMinor: 1000 });
  });
});
