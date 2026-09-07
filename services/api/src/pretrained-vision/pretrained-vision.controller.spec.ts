import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { PretrainedVisionController } from './pretrained-vision.module';
import { PretrainedVisionService } from './pretrained-vision.service';

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

describe('PretrainedVisionController.providers (Codex P1)', () => {
  it('awaits the async status list so the response carries an ARRAY, never a nested promise', async () => {
    const statuses = [
      {
        provider: 'CLASSICAL',
        kind: 'CLASSICAL',
        availability: 'READY',
        reasonCode: null,
        stubMode: false,
        runtime: null,
      },
    ];
    const service = {
      providerStatuses: jest.fn(async () => statuses),
    } as unknown as PretrainedVisionService;
    const controller = new PretrainedVisionController(service);
    const response = await controller.providers();
    expect(Array.isArray(response.providers)).toBe(true);
    expect(response.providers).toEqual(statuses);
    // What Express would serialize: the array, not "{}".
    expect(JSON.parse(JSON.stringify(response))).toEqual({ providers: statuses });
  });
});
