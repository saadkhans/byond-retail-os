import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import {
  QueryBalancesReportDto,
  QueryCvAccuracyReportDto,
  QuerySalesReportDto,
} from './reporting.dto';
import { ReportingController } from './reporting.controller';

const HANDLERS = [
  'sales',
  'explainOrder',
  'movements',
  'balances',
  'countReconciliation',
  'shrink',
  'cvAccuracy',
] as const;

/**
 * Access-policy pin for the reporting surface.
 *
 * Two properties matter more here than on any other controller.
 *
 *  1. IT IS ALL GET. A report that could write would be a second source of
 *     truth; the assertion below fails the build if a non-GET route is ever
 *     added to this controller.
 *  2. EVERY ROUTE DEMANDS THE DOMAIN PERMISSION AS WELL AS `report:read`.
 *     @RequirePermissions is AND semantics, so reporting can never become a
 *     side door to rows a caller could not already read one at a time.
 */
describe('reporting controller access policy', () => {
  it('is tenant-only and gated on the reporting module', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, ReportingController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, ReportingController)).toBe(
      'reporting',
    );
  });

  it('exposes nothing but GET routes', () => {
    for (const handler of HANDLERS) {
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          ReportingController.prototype[handler],
        ),
      ).toBe(RequestMethod.GET);
    }
  });

  it('declares no handler this pin does not know about', () => {
    const proto = ReportingController.prototype as unknown as Record<
      string,
      object
    >;
    const declared = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined,
    );
    expect(declared.sort()).toEqual([...HANDLERS].sort());
  });

  const expected: Record<(typeof HANDLERS)[number], string[]> = {
    sales: ['report:read', 'order:read'],
    explainOrder: ['report:read', 'order:read'],
    movements: ['report:read', 'inventory:read'],
    balances: ['report:read', 'inventory:read'],
    countReconciliation: ['report:read', 'cycle-count:read'],
    shrink: ['report:read', 'shrink:read'],
    cvAccuracy: ['report:read', 'vision:read'],
  };

  for (const handler of HANDLERS) {
    it(`${handler} requires report:read plus the permission that already guards its rows`, () => {
      const permissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        ReportingController.prototype[handler],
      );
      expect(permissions).toEqual(expected[handler]);
      expect(permissions).toContain('report:read');
      expect(permissions.length).toBe(2);
    });
  }
});

describe('reporting controller delegates with the caller’s tenant', () => {
  const reporting = {
    salesReport: jest.fn(async () => ({})),
    explainOrder: jest.fn(async () => ({})),
    movementReport: jest.fn(async () => ({})),
    balanceReport: jest.fn(async () => ({})),
    countReconciliationReport: jest.fn(async () => ({})),
    shrinkReport: jest.fn(async () => ({})),
    cvAccuracyReport: jest.fn(async () => ({})),
  };
  const controller = new ReportingController(reporting as never);

  beforeEach(() => jest.clearAllMocks());

  it('passes the authenticated tenant, never one from the query string', async () => {
    await controller.sales('tenant-1', {});
    expect(reporting.salesReport).toHaveBeenCalledWith('tenant-1', {});
    await controller.explainOrder('tenant-1', 'order-9');
    expect(reporting.explainOrder).toHaveBeenCalledWith('tenant-1', 'order-9');
    await controller.movements('tenant-1', {});
    expect(reporting.movementReport).toHaveBeenCalledWith('tenant-1', {});
    await controller.balances('tenant-1', {});
    expect(reporting.balanceReport).toHaveBeenCalledWith('tenant-1', {});
    await controller.countReconciliation('tenant-1', {});
    expect(reporting.countReconciliationReport).toHaveBeenCalledWith(
      'tenant-1',
      {},
    );
    await controller.shrink('tenant-1', {});
    expect(reporting.shrinkReport).toHaveBeenCalledWith('tenant-1', {});
  });

  it('hands the CV report the caller’s OWN permissions, so the video boundary is theirs', async () => {
    await controller.cvAccuracy(
      'tenant-1',
      { evaluationRunId: 'run-1' },
      {
        userId: 'u1',
        email: 'a@example.com',
        userType: 'TENANT_USER',
        tenantId: 'tenant-1',
        permissions: ['vision:read', 'video-asset:read'],
        requestId: 'req-1',
      } as never,
    );
    expect(reporting.cvAccuracyReport).toHaveBeenCalledWith(
      'tenant-1',
      { evaluationRunId: 'run-1' },
      { permissions: ['vision:read', 'video-asset:read'] },
    );
  });
});

describe('reporting query DTOs', () => {
  it('rejects a window end that is not an instant', async () => {
    const dto = plainToInstance(QuerySalesReportDto, { to: 'yesterday' });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(['to']);
  });

  it('caps the balance page size', async () => {
    const dto = plainToInstance(QueryBalancesReportDto, { take: 5000 });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(['take']);
  });

  it('requires an evaluation run for the CV accuracy report', async () => {
    const errors = await validate(
      plainToInstance(QueryCvAccuracyReportDto, {}),
    );
    expect(errors.map((error) => error.property)).toEqual(['evaluationRunId']);
  });

  it('accepts only ids and instants — every declared field is a filter, never prose', async () => {
    // A DTO with a free-text field would be the one way a pasted card number
    // could reach this module. There is none: the accepted shape is exactly
    // these keys, and `read-only.spec.ts` greps the directory to keep it so.
    const sales = plainToInstance(QuerySalesReportDto, {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-16T00:00:00.000Z',
      locationId: 'loc-1',
      productId: 'prod-1',
    });
    await expect(validate(sales)).resolves.toEqual([]);
    expect(Object.keys(sales).sort()).toEqual([
      'from',
      'locationId',
      'productId',
      'to',
    ]);
  });
});
