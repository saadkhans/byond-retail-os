import { PrismaService } from '../prisma/prisma.service';
import { ReportingRepository } from './reporting.repository';

/**
 * Tenant isolation at the data layer, for a module that only reads.
 *
 * AGENTS.md says every query touching tenant data must be scoped by tenant id
 * at the data-access layer. For a WRITE the usual failure is a predicate that
 * leans on a preceding lookup; for a READ the failure is quieter and worse —
 * one tenant's report silently containing another tenant's rows. So every
 * method here is called with a tenant and the predicate it actually sent is
 * inspected, including the RELATION filters, which repeat the tenant rather
 * than trusting the join.
 */
const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-16T00:00:00.000Z');

interface Call {
  model: string;
  operation: string;
  args: Record<string, unknown>;
}

function buildHarness() {
  const calls: Call[] = [];
  const record =
    (model: string, operation: string, result: unknown) =>
    (args: Record<string, unknown> = {}) => {
      calls.push({ model, operation, args });
      return Promise.resolve(result);
    };

  const groupResult = (extra: Record<string, unknown>) => [
    {
      _sum: {
        quantity: 0,
        lineTotalMinor: 0,
        quantityDelta: 0,
        varianceQuantity: 0,
        ledgerDriftQuantity: 0,
      },
      _count: { _all: 0 },
      ...extra,
    },
  ];

  const prisma = {
    orderLine: {
      groupBy: jest.fn(
        record(
          'orderLine',
          'groupBy',
          groupResult({
            productId: 'p1',
            sku: 'SKU-1',
            productName: 'Water',
            currencyCode: 'GBP',
            priceBookVersionId: 'pbv',
            promotionVersionId: null,
            basePriceMinor: 100,
            promotionDiscountMinor: null,
            unitPriceMinor: 100,
          }),
        ),
      ),
      aggregate: jest.fn(
        record('orderLine', 'aggregate', {
          _sum: { quantity: 1, lineTotalMinor: 100 },
          _count: { _all: 1 },
        }),
      ),
    },
    order: {
      findFirst: jest.fn(record('order', 'findFirst', null)),
    },
    inventoryMovement: {
      groupBy: jest.fn(
        record(
          'inventoryMovement',
          'groupBy',
          groupResult({
            movementType: 'SALE',
            locationId: 'loc-1',
            productId: 'p1',
          }),
        ),
      ),
      aggregate: jest.fn(
        record('inventoryMovement', 'aggregate', {
          _sum: { quantityDelta: -5 },
          _count: { _all: 2 },
        }),
      ),
    },
    inventoryLevel: {
      findMany: jest.fn(record('inventoryLevel', 'findMany', [])),
    },
    cycleCountLine: {
      aggregate: jest.fn(
        record('cycleCountLine', 'aggregate', {
          _sum: { varianceQuantity: -3, ledgerDriftQuantity: 0 },
          _count: { _all: 4 },
        }),
      ),
      count: jest.fn(record('cycleCountLine', 'count', 1)),
    },
    shrinkEvent: {
      groupBy: jest.fn(
        record(
          'shrinkEvent',
          'groupBy',
          groupResult({ productId: 'p1', source: 'CV_DETECTED' }),
        ),
      ),
    },
    orderReturnLine: {
      groupBy: jest.fn(
        record('orderReturnLine', 'groupBy', groupResult({ productId: 'p1' })),
      ),
    },
    pilotEvaluationRun: {
      findFirst: jest.fn(record('pilotEvaluationRun', 'findFirst', { id: 'run' })),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
      calls.push({
        model: '$queryRaw',
        operation: 'raw',
        args: { sql: strings.join('?'), params },
      });
      return Promise.resolve([]);
    }),
  };

  return {
    calls,
    prisma,
    repository: new ReportingRepository(prisma as unknown as PrismaService),
  };
}

/** Recursively collect every `tenantId` value anywhere in a predicate. */
function tenantIdsIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(tenantIdsIn);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, inner]) =>
        key === 'tenantId' && typeof inner === 'string'
          ? [inner]
          : tenantIdsIn(inner),
    );
  }
  return [];
}

async function callEveryRead(repository: ReportingRepository, tenantId: string) {
  const window = { from: FROM, to: TO };
  await repository.salesPricePoints(tenantId, { ...window, take: 10 });
  await repository.salesTotals(tenantId, window);
  await repository.orderWithProvenance(tenantId, 'order-1');
  await repository.movementSummary(tenantId, window);
  await repository.ledgerBalances(tenantId, { skip: 0, take: 10 });
  await repository.projectedBalances(tenantId, [
    { locationId: 'loc-1', productId: 'p1' },
  ]);
  await repository.countReconciliation(tenantId, window);
  await repository.shrinkGroups(tenantId, window);
  await repository.shrinkLedgerTotals(tenantId, window);
  await repository.damagedReturnGroups(tenantId, window);
  await repository.evaluationRunExists(tenantId, 'run-1');
  await repository.latestVerdictGroups(tenantId, 'run-1', {
    includeVideoObservations: false,
  });
}

describe('reporting repository — tenant isolation', () => {
  it('names the caller tenant in every single read it issues', async () => {
    const { repository, calls } = buildHarness();
    await callEveryRead(repository, TENANT);

    expect(calls.length).toBeGreaterThanOrEqual(13);
    for (const call of calls) {
      if (call.model === '$queryRaw') {
        // The raw statement binds the tenant as a parameter — never
        // interpolated, and present in the WHERE clause.
        expect(call.args.sql).toContain('r."tenantId" = ');
        expect(call.args.params).toContain(TENANT);
        continue;
      }
      const tenants = tenantIdsIn(call.args.where);
      expect(
        tenants.length > 0 ? null : `${call.model}.${call.operation} has no tenantId`,
      ).toBeNull();
      expect(new Set(tenants)).toEqual(new Set([TENANT]));
    }
  });

  it('never leaks another tenant into a relation filter', async () => {
    const { repository, calls } = buildHarness();
    await callEveryRead(repository, TENANT);
    const serialised = JSON.stringify(calls);
    expect(serialised).not.toContain(OTHER);
  });

  it('repeats the tenant inside the order relation filter, not just on the line', async () => {
    const { repository, prisma } = buildHarness();
    await repository.salesPricePoints(TENANT, { from: FROM, to: TO, take: 5 });
    const args = prisma.orderLine.groupBy.mock.calls[0][0] as unknown as {
      where: { tenantId: string; order: { is: { tenantId: string } } };
    };
    expect(args.where.tenantId).toBe(TENANT);
    expect(args.where.order.is.tenantId).toBe(TENANT);
  });

  it('repeats the tenant inside the return relation filter for damaged returns', async () => {
    const { repository, prisma } = buildHarness();
    await repository.damagedReturnGroups(TENANT, {
      from: FROM,
      to: TO,
      locationId: 'loc-1',
    });
    const args = prisma.orderReturnLine.groupBy.mock.calls[0][0] as unknown as {
      where: {
        tenantId: string;
        restocked: boolean;
        return: { is: { tenantId: string; order: { is: { tenantId: string } } } };
      };
    };
    expect(args.where.tenantId).toBe(TENANT);
    expect(args.where.restocked).toBe(false);
    expect(args.where.return.is.tenantId).toBe(TENANT);
    expect(args.where.return.is.order.is.tenantId).toBe(TENANT);
  });
});

describe('reporting repository — reads only, aggregated in the database', () => {
  it('issues no write of any kind', async () => {
    const { repository, calls } = buildHarness();
    await callEveryRead(repository, TENANT);
    const writes = calls.filter((call) =>
      /^(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw)/.test(
        call.operation,
      ),
    );
    expect(writes).toEqual([]);
  });

  it('asks the database to aggregate rather than fetching rows to add up', async () => {
    const { repository, calls } = buildHarness();
    await callEveryRead(repository, TENANT);
    // The only findMany in the module is the bounded projection lookup for a
    // page of (location, product) pairs; everything else is groupBy/aggregate/
    // count, or the one DISTINCT ON statement.
    const findManys = calls.filter((call) => call.operation === 'findMany');
    expect(findManys.map((call) => call.model)).toEqual(['inventoryLevel']);
    expect(
      calls.filter((call) =>
        ['groupBy', 'aggregate', 'count'].includes(call.operation),
      ).length,
    ).toBeGreaterThanOrEqual(8);
  });

  it('only ever sums CONFIRMED orders as sales', async () => {
    const { repository, prisma } = buildHarness();
    await repository.salesTotals(TENANT, { from: FROM, to: TO });
    const args = prisma.orderLine.aggregate.mock.calls[0][0] as unknown as {
      where: { order: { is: { status: string; placedAt: unknown } } };
    };
    expect(args.where.order.is.status).toBe('CONFIRMED');
    expect(args.where.order.is.placedAt).toEqual({ gte: FROM, lt: TO });
  });

  it('sums variance and ledger drift into separate aggregates, never one figure', async () => {
    const { repository, prisma } = buildHarness();
    await repository.countReconciliation(TENANT, { from: FROM, to: TO });
    const args = prisma.cycleCountLine.aggregate.mock.calls[0][0] as unknown as {
      _sum: Record<string, boolean>;
    };
    expect(args._sum).toEqual({
      varianceQuantity: true,
      ledgerDriftQuantity: true,
    });
    // Two separate non-zero line counts, so neither number is inferred from
    // the other.
    expect(prisma.cycleCountLine.count).toHaveBeenCalledTimes(2);
  });

  it('derives the balance from the ledger and the projection from its own table', async () => {
    const { repository, prisma } = buildHarness();
    await repository.ledgerBalances(TENANT, { skip: 0, take: 25 });
    const args = prisma.inventoryMovement.groupBy.mock.calls[0][0] as unknown as {
      by: string[];
      _sum: Record<string, boolean>;
      take: number;
    };
    expect(args.by).toEqual(['locationId', 'productId']);
    expect(args._sum).toEqual({ quantityDelta: true });
    expect(args.take).toBe(25);
  });

  it('asks the projection only for the pairs on the page', async () => {
    const { repository, prisma } = buildHarness();
    await repository.projectedBalances(TENANT, [
      { locationId: 'loc-1', productId: 'p1' },
      { locationId: 'loc-2', productId: 'p2' },
    ]);
    const args = prisma.inventoryLevel.findMany.mock.calls[0][0] as unknown as {
      where: { OR: { locationId: string; productId: string }[] };
    };
    expect(args.where.OR).toHaveLength(2);
  });

  it('skips the projection lookup entirely when the page is empty', async () => {
    const { repository, prisma } = buildHarness();
    await expect(repository.projectedBalances(TENANT, [])).resolves.toEqual([]);
    expect(prisma.inventoryLevel.findMany).not.toHaveBeenCalled();
  });
});

describe('reporting repository — the CV accuracy statement', () => {
  it('selects the newest review per observation, in the database', async () => {
    const { repository, calls } = buildHarness();
    await repository.latestVerdictGroups(TENANT, 'run-1', {
      includeVideoObservations: true,
    });
    const sql = calls[0].args.sql as string;
    expect(sql).toContain('DISTINCT ON (COALESCE(r."journeyEventId", r."id"))');
    expect(sql).toContain('r."createdAt" DESC');
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('GROUP BY 1, 2, 3, 4, 5');
  });

  it('projects counts and catalog identity only — no evidence of any kind', async () => {
    const { repository, calls } = buildHarness();
    await repository.latestVerdictGroups(TENANT, 'run-1', {
      includeVideoObservations: true,
    });
    const sql = (calls[0].args.sql as string).toLowerCase();
    for (const column of [
      'evidencebundle',
      'visionevent',
      'operatorcropartifactid',
      'notes',
      'storagekey',
      'videoassetid',
      'reviewedbyid',
      'matchscore',
    ]) {
      expect(sql).not.toContain(column);
    }
  });

  it('excludes the true-negative REVIEW_REQUIRED observations from scoring', async () => {
    const { repository, calls } = buildHarness();
    await repository.latestVerdictGroups(TENANT, 'run-1', {
      includeVideoObservations: true,
    });
    expect(calls[0].args.sql).toContain(`e."eventType" <> 'REVIEW_REQUIRED'`);
  });

  it('gates video-backed observations on the caller clearing the video boundary', async () => {
    const { repository, calls } = buildHarness();
    await repository.latestVerdictGroups(TENANT, 'run-1', {
      includeVideoObservations: false,
    });
    expect(calls[0].args.sql).toContain(`e."sourceType" <> 'FUSION_SHADOW'`);
    // The flag is a bound parameter, so the same statement serves both cases
    // and neither can be reached by string manipulation.
    expect(calls[0].args.params).toContain(false);

    const second = buildHarness();
    await second.repository.latestVerdictGroups(TENANT, 'run-1', {
      includeVideoObservations: true,
    });
    expect(second.calls[0].args.params).toContain(true);
  });
});
