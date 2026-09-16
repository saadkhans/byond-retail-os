import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { MAX_SALES_PRICE_POINTS } from './reporting.constants';
import { ReportingRepository } from './reporting.repository';
import { ReportingService } from './reporting.service';

/**
 * What the service adds on top of the arithmetic: the refusals.
 *
 * A report is only ever allowed to show what the platform already lets this
 * caller see, and is only ever allowed to publish a number it can stand
 * behind. So the interesting tests here are the ones where it says no — to a
 * disabled source module, to a breakdown it could not complete, and to
 * video-backed observations a caller has not cleared the boundary for.
 */
const TENANT = 'tenant-a';

type RepositoryStub = Partial<Record<keyof ReportingRepository, unknown>>;

function buildService(
  repository: RepositoryStub = {},
  enabledModules: string[] = [
    'checkout',
    'inventory',
    'returns',
    'cv',
    'video-ingest',
  ],
) {
  const isEnabledForTenant = jest.fn(async (_tenantId: string, code: string) =>
    enabledModules.includes(code),
  );
  const repo = {
    salesPricePoints: jest.fn(async () => []),
    salesTotals: jest.fn(async () => ({ units: 0, netSalesMinor: 0, lines: 0 })),
    orderWithProvenance: jest.fn(async () => null),
    movementSummary: jest.fn(async () => []),
    ledgerBalances: jest.fn(async () => []),
    projectedBalances: jest.fn(async () => []),
    countReconciliation: jest.fn(async () => ({
      lines: 0,
      varianceQuantitySum: 0,
      varianceLines: 0,
      ledgerDriftQuantitySum: 0,
      ledgerDriftLines: 0,
    })),
    shrinkGroups: jest.fn(async () => []),
    shrinkLedgerTotals: jest.fn(async () => ({
      quantityDeltaSum: 0,
      movements: 0,
    })),
    damagedReturnGroups: jest.fn(async () => []),
    evaluationRunExists: jest.fn(async () => true),
    latestVerdictGroups: jest.fn(async () => []),
    ...repository,
  };
  const service = new ReportingService(
    repo as unknown as ReportingRepository,
    { isEnabledForTenant } as unknown as PlatformModulesService,
  );
  return { service, repo, isEnabledForTenant };
}

describe('reporting service — it adds no reach', () => {
  interface ReportCase {
    label: string;
    sourceModule: string;
    call: (service: ReportingService) => Promise<unknown>;
  }

  const cases: ReportCase[] = [
    {
      label: 'sales',
      sourceModule: 'checkout',
      call: (service) => service.salesReport(TENANT, {}),
    },
    {
      label: 'inventory movements',
      sourceModule: 'inventory',
      call: (service) => service.movementReport(TENANT, {}),
    },
    {
      label: 'inventory balances',
      sourceModule: 'inventory',
      call: (service) => service.balanceReport(TENANT, {}),
    },
    {
      label: 'count reconciliation',
      sourceModule: 'returns',
      call: (service) => service.countReconciliationReport(TENANT, {}),
    },
    {
      label: 'shrink',
      sourceModule: 'returns',
      call: (service) => service.shrinkReport(TENANT, {}),
    },
    {
      label: 'CV accuracy',
      sourceModule: 'cv',
      call: (service) =>
        service.cvAccuracyReport(
          TENANT,
          { evaluationRunId: 'run' },
          { permissions: [] },
        ),
    },
  ];

  for (const testCase of cases) {
    it(`refuses the ${testCase.label} report when the ${testCase.sourceModule} module is disabled`, async () => {
      const { service } = buildService(
        {},
        ['checkout', 'inventory', 'returns', 'cv'].filter(
          (code) => code !== testCase.sourceModule,
        ),
      );
      await expect(testCase.call(service)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  }

  it('publishes the enabled source module check before touching any data', async () => {
    const { service, repo } = buildService({}, []);
    await expect(service.salesReport(TENANT, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.salesPricePoints).not.toHaveBeenCalled();
  });
});

describe('reporting service — sales', () => {
  const pricePoint = (overrides: Record<string, unknown> = {}) => ({
    productId: 'p1',
    sku: 'SKU-1',
    productName: 'Water',
    currencyCode: 'GBP',
    priceBookVersionId: 'pbv-1',
    promotionVersionId: 'promo-1',
    basePriceMinor: 250,
    promotionDiscountMinor: 50,
    unitPriceMinor: 200,
    units: 5,
    lineTotalMinor: 1000,
    lines: 2,
    ...overrides,
  });

  it('reconciles the grouped roll-up against an independent ungrouped SUM', async () => {
    const { service } = buildService({
      salesPricePoints: jest.fn(async () => [pricePoint()]),
      salesTotals: jest.fn(async () => ({
        units: 5,
        netSalesMinor: 1000,
        lines: 2,
      })),
    });
    const report = await service.salesReport(TENANT, {});
    expect(report.totals.byCurrency[0].grossSalesMinor).toBe(1250);
    expect(report.totals.byCurrency[0].promotionDiscountMinor).toBe(250);
    expect(report.totals.byCurrency[0].netSalesMinor).toBe(1000);
    expect(report.crossCheck.netSalesMinorFromOrderLines).toBe(1000);
    expect(report.crossCheck.reconciled).toBe(true);
  });

  it('says so when the roll-up and the independent SUM disagree', async () => {
    const { service } = buildService({
      salesPricePoints: jest.fn(async () => [pricePoint()]),
      salesTotals: jest.fn(async () => ({
        units: 5,
        netSalesMinor: 999,
        lines: 2,
      })),
    });
    const report = await service.salesReport(TENANT, {});
    expect(report.crossCheck.reconciled).toBe(false);
  });

  it('refuses rather than returning a truncated breakdown that understates revenue', async () => {
    const overflow = Array.from({ length: MAX_SALES_PRICE_POINTS + 1 }, () =>
      pricePoint(),
    );
    const { service } = buildService({
      salesPricePoints: jest.fn(async () => overflow),
    });
    await expect(service.salesReport(TENANT, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('asks for one row beyond the cap so it can tell complete from truncated', async () => {
    const { service, repo } = buildService();
    await service.salesReport(TENANT, {});
    expect(repo.salesPricePoints).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ take: MAX_SALES_PRICE_POINTS + 1 }),
    );
  });

  it('echoes the window it actually used and says the numbers were derived on read', async () => {
    const { service } = buildService();
    const report = await service.salesReport(TENANT, {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-08T00:00:00.000Z',
    });
    expect(report.window).toEqual({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-08T00:00:00.000Z',
    });
    expect(report.provenance.derivation).toBe('DERIVED_ON_READ');
    expect(report.provenance.stale).toBe(false);
    expect(report.provenance.sourceOfTruth).toContain('OrderLine');
    expect(Date.parse(report.provenance.generatedAt)).not.toBeNaN();
  });

  it('rejects an inverted window instead of silently reporting nothing', async () => {
    const { service } = buildService();
    await expect(
      service.salesReport(TENANT, {
        from: '2026-09-08T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('reporting service — explaining one sale', () => {
  const order = {
    id: 'order-1',
    orderNumber: 'ORD-000001',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    placedAt: new Date('2026-09-10T10:00:00.000Z'),
    locationId: 'loc-1',
    totalQuantity: 3,
    subtotalMinor: 600,
    totalMinor: 600,
    currencyCode: 'GBP',
    lines: [
      {
        id: 'ol-1',
        productId: 'p1',
        sku: 'SKU-1',
        productName: 'Water',
        quantity: 3,
        unitPriceMinor: 200,
        lineTotalMinor: 600,
        currencyCode: 'GBP',
        basePriceMinor: 250,
        promotionDiscountMinor: 50,
        priceBookVersion: {
          id: 'pbv-1',
          versionNumber: 4,
          status: 'ACTIVE',
          effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
          effectiveTo: null,
          activatedAt: new Date('2026-09-01T00:00:00.000Z'),
          reason: 'PRICE_CHANGE',
          priceBook: {
            id: 'pb-1',
            code: 'DEFAULT',
            name: 'Default book',
            currencyCode: 'GBP',
          },
        },
        promotionVersion: {
          id: 'promo-v1',
          versionNumber: 2,
          status: 'ACTIVE',
          effectiveFrom: new Date('2026-09-05T00:00:00.000Z'),
          effectiveTo: null,
          activatedAt: new Date('2026-09-05T00:00:00.000Z'),
          reason: 'CAMPAIGN',
          promotion: {
            id: 'promo-1',
            code: 'AUTUMN',
            name: 'Autumn 20p off',
            audience: 'ALL_SHOPPERS',
          },
        },
      },
    ],
  };

  it('traces the line back to the price version and the promotion version', async () => {
    const { service } = buildService({
      orderWithProvenance: jest.fn(async () => order),
    });
    const report = await service.explainOrder(TENANT, 'order-1');
    const line = report.lines[0];
    expect(line.priceBookVersion).toMatchObject({
      id: 'pbv-1',
      versionNumber: 4,
      priceBookCode: 'DEFAULT',
    });
    expect(line.promotionVersion).toMatchObject({
      id: 'promo-v1',
      versionNumber: 2,
      promotionCode: 'AUTUMN',
    });
    // 250 from the price version, 50 off by the promotion, 200 charged,
    // x3 = 600.
    expect(line.basePriceMinor).toBe(250);
    expect(line.promotionDiscountMinor).toBe(50);
    expect(line.checks).toEqual({
      unitPriceMatchesBaseMinusDiscount: true,
      lineTotalMatchesUnitTimesQuantity: true,
    });
    expect(report.totals[0].grossSalesMinor).toBe(750);
    expect(report.totals[0].promotionDiscountMinor).toBe(150);
    expect(report.totals[0].netSalesMinor).toBe(600);
    // And the recomputed net matches the total the order itself snapshotted.
    expect(report.reconciled).toBe(true);
  });

  it('never projects the CV evidence lineage an order line also carries', async () => {
    const { service } = buildService({
      orderWithProvenance: jest.fn(async () => order),
    });
    const serialised = JSON.stringify(await service.explainOrder(TENANT, 'order-1'));
    for (const leak of [
      'evidenceBundleId',
      'visionEventId',
      'evidenceScore',
      'vlmReviewId',
      'reasonCodes',
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('404s on an order that belongs to another tenant', async () => {
    const { service } = buildService({
      orderWithProvenance: jest.fn(async () => null),
    });
    await expect(service.explainOrder(TENANT, 'order-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('reporting service — inventory', () => {
  it('reports the ledger balance and names the projection as a cross-check only', async () => {
    const { service } = buildService({
      ledgerBalances: jest.fn(async () => [
        { locationId: 'loc-1', productId: 'p1', ledgerQuantity: 18, movements: 4 },
      ]),
      projectedBalances: jest.fn(async () => [
        { locationId: 'loc-1', productId: 'p1', quantity: 20 },
      ]),
    });
    const report = await service.balanceReport(TENANT, {});
    expect(report.rows[0].ledgerQuantity).toBe(18);
    expect(report.rows[0].projectionDriftQuantity).toBe(2);
    expect(report.summary.projectionHealthy).toBe(false);
    expect(report.balanceSource).toContain('append-only ledger');
  });

  it('asks the projection only about the pairs the ledger page returned', async () => {
    const { service, repo } = buildService({
      ledgerBalances: jest.fn(async () => [
        { locationId: 'loc-1', productId: 'p1', ledgerQuantity: 1, movements: 1 },
      ]),
    });
    await service.balanceReport(TENANT, {});
    expect(repo.projectedBalances).toHaveBeenCalledWith(TENANT, [
      { locationId: 'loc-1', productId: 'p1' },
    ]);
  });

  it('keeps the count variance and the projection defect in separate blocks', async () => {
    const { service } = buildService({
      countReconciliation: jest.fn(async () => ({
        lines: 4,
        varianceQuantitySum: -7,
        varianceLines: 3,
        ledgerDriftQuantitySum: 1,
        ledgerDriftLines: 1,
      })),
    });
    const report = await service.countReconciliationReport(TENANT, {});
    expect(report.variance.totalQuantity).toBe(-7);
    expect(report.projectionDefect.totalDriftQuantity).toBe(1);
    expect(report.projectionDefect.severity).toBe('PLATFORM_DEFECT');
    expect(report.varianceIncludesDrift).toBe(false);
  });
});

describe('reporting service — shrink', () => {
  it('reports shrink and damaged returns as two different things', async () => {
    const { service } = buildService({
      shrinkGroups: jest.fn(async () => [
        { productId: 'p1', source: 'CV_DETECTED', units: 6, events: 3 },
      ]),
      shrinkLedgerTotals: jest.fn(async () => ({
        quantityDeltaSum: -6,
        movements: 3,
      })),
      damagedReturnGroups: jest.fn(async () => [
        { productId: 'p2', units: 4, lines: 2 },
      ]),
    });
    const report = await service.shrinkReport(TENANT, {});
    expect(report.shrink.units).toBe(6);
    expect(report.damagedReturns.units).toBe(4);
    expect(report.ledgerCheck.reconciled).toBe(true);
    expect(report.damagedReturns.ledgerMovementsWritten).toBe(0);
  });
});

describe('reporting service — CV accuracy stays inside the review boundary', () => {
  it('excludes video-backed observations from a caller without video-asset:read', async () => {
    const { service, repo } = buildService();
    const report = await service.cvAccuracyReport(
      TENANT,
      { evaluationRunId: 'run-1' },
      { permissions: ['vision:read', 'report:read'] },
    );
    expect(repo.latestVerdictGroups).toHaveBeenCalledWith(TENANT, 'run-1', {
      includeVideoObservations: false,
    });
    expect(report.scope.videoBackedObservationsIncluded).toBe(false);
    expect(report.scope.excluded).toContain('video-asset:read');
  });

  it('includes them only when the caller holds video-asset:read AND the module is on', async () => {
    const { service, repo } = buildService();
    await service.cvAccuracyReport(
      TENANT,
      { evaluationRunId: 'run-1' },
      { permissions: ['vision:read', 'video-asset:read'] },
    );
    expect(repo.latestVerdictGroups).toHaveBeenCalledWith(TENANT, 'run-1', {
      includeVideoObservations: true,
    });
  });

  it('still excludes them when the tenant has video-ingest switched off', async () => {
    const { service, repo } = buildService({}, ['cv']);
    await service.cvAccuracyReport(
      TENANT,
      { evaluationRunId: 'run-1' },
      { permissions: ['vision:read', 'video-asset:read'] },
    );
    expect(repo.latestVerdictGroups).toHaveBeenCalledWith(TENANT, 'run-1', {
      includeVideoObservations: false,
    });
  });

  it('404s on an evaluation run from another tenant', async () => {
    const { service } = buildService({
      evaluationRunExists: jest.fn(async () => false),
    });
    await expect(
      service.cvAccuracyReport(
        TENANT,
        { evaluationRunId: 'run-x' },
        { permissions: [] },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns counts and rates, and nothing that could identify a piece of evidence', async () => {
    const { service } = buildService({
      latestVerdictGroups: jest.fn(async () => [
        {
          verdict: 'CORRECT',
          predictedAction: 'PICKUP',
          expectedAction: 'PICKUP',
          predictedSku: 'SKU-1',
          expectedSku: 'SKU-1',
          count: 4,
        },
      ]),
    });
    const report = await service.cvAccuracyReport(
      TENANT,
      { evaluationRunId: 'run-1' },
      { permissions: ['vision:read'] },
    );
    expect(report.accuracy.combined).toBe(1);
    const serialised = JSON.stringify(report).toLowerCase();
    for (const leak of [
      'evidencebundle',
      'visionevent',
      'storagekey',
      'artifact',
      'videoasset',
      'journeyevent',
      'notes',
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });
});
