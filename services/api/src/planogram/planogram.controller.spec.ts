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
