import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { OneSkuBootstrapController } from './one-sku-bootstrap.module';

/**
 * Access-policy pin: the one-SKU bootstrap report is tenant-scoped,
 * cv-module-gated, and read-permission-only. Fails loudly if a refactor
 * loses (or broadens) its policy metadata.
 */
describe('OneSkuBootstrapController access policy', () => {
  it('is tenant-only and gated on the cv module at the class level', () => {
    expect(
      Reflect.getMetadata(TENANT_ONLY_KEY, OneSkuBootstrapController),
    ).toBe(true);
    expect(
      Reflect.getMetadata(REQUIRED_MODULE_KEY, OneSkuBootstrapController),
    ).toBe('cv');
  });

  it('requires only vision:read on the report route', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        OneSkuBootstrapController.prototype.report,
      ),
    ).toEqual(['vision:read']);
  });
});
