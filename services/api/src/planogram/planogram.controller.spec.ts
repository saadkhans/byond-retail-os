import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { PlanogramController } from './planogram.module';

/**
 * Access-policy pin for the Phase 19 planogram surface: tenant-scoped
 * and cv-module-gated; reads need vision:read, layout publication and
 * deactivation need vision:review.
 */
describe('PlanogramController access policy', () => {
  it('is tenant-only and gated on the cv module at the class level', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, PlanogramController)).toBe(
      true,
    );
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, PlanogramController)).toBe(
      'cv',
    );
  });

  it.each([
    ['listRacks', ['vision:read']],
    ['narrow', ['vision:read']],
    ['publishRack', ['vision:review']],
    ['deactivateRack', ['vision:review']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PlanogramController.prototype[handler],
      ),
    ).toEqual(expected);
  });
});

describe('PlanogramController.narrow coordinate validation', () => {
  const planograms = {
    narrowCandidates: jest.fn(async () => null),
  };
  const controller = new PlanogramController(planograms as never);

  beforeEach(() => planograms.narrowCandidates.mockClear());

  it.each([
    ['x=999', '999', '0.5'],
    ['x=-1', '-1', '0.5'],
    ['y=2', '0.5', '2'],
    ['x=not-a-number', 'abc', '0.5'],
  ])('rejects %s instead of silently clamping to an edge cell', async (_label, x, y) => {
    await expect(
      controller.narrow('tenant-1', 'store-1', 'R1', x, y),
    ).rejects.toThrow(/between 0 and 1/);
    expect(planograms.narrowCandidates).not.toHaveBeenCalled();
  });

  it('treats MISSING coordinates as unknown cell (rack fallback path)', async () => {
    await controller.narrow('tenant-1', 'store-1', 'R1');
    expect(planograms.narrowCandidates).toHaveBeenCalledWith('tenant-1', {
      locationId: 'store-1',
      rackCode: 'R1',
      normalizedRackX: null,
      normalizedRackY: null,
    });
  });

  it('accepts valid normalized coordinates', async () => {
    await controller.narrow('tenant-1', 'store-1', 'R1', '0.62', '0.38');
    expect(planograms.narrowCandidates).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        normalizedRackX: 0.62,
        normalizedRackY: 0.38,
      }),
    );
  });
});
