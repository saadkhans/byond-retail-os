import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { PretrainedVisionController } from './pretrained-vision.module';

/**
 * Access-policy pin for the Phase 19 pretrained-vision surface:
 * tenant-scoped, cv-module-gated; reads need vision:read and the
 * evaluation write needs vision:review. (The service ADDITIONALLY
 * enforces the video-asset read boundary — video-ingest module +
 * video-asset:read — on evaluate and report.)
 */
describe('PretrainedVisionController access policy', () => {
  it('is tenant-only and gated on the cv module at the class level', () => {
    expect(
      Reflect.getMetadata(TENANT_ONLY_KEY, PretrainedVisionController),
    ).toBe(true);
    expect(
      Reflect.getMetadata(REQUIRED_MODULE_KEY, PretrainedVisionController),
    ).toBe('cv');
  });

  it.each([
    ['providers', ['vision:read']],
    ['report', ['vision:read']],
    ['evaluate', ['vision:review']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PretrainedVisionController.prototype[handler],
      ),
    ).toEqual(expected);
  });
});
