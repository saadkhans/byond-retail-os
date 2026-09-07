import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { ClipLabController } from './clip-lab.module';

/**
 * Access-policy pin for the Phase 22 Clip Lab surface: tenant-scoped,
 * cv-module-gated; the read needs vision:read and the orchestrated run
 * needs vision:review. (The service ADDITIONALLY enforces the video-asset
 * read boundary — video-ingest module + video-asset:read.)
 */
describe('ClipLabController access policy', () => {
  it('is tenant-only and gated on the cv module at the class level', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, ClipLabController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, ClipLabController)).toBe('cv');
  });

  it.each([
    ['report', ['vision:read']],
    ['run', ['vision:review']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        ClipLabController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it('passes the video-asset:read boundary flag from the actor permissions', async () => {
    const lab = { run: jest.fn(async () => ({})), report: jest.fn(async () => ({})) };
    const controller = new ClipLabController(lab as never);
    await controller.run('tenant-1', 'va-1', {
      userId: 'u-1',
      email: 'a@b.c',
      permissions: ['vision:review'],
    } as never);
    expect(lab.run).toHaveBeenCalledWith(
      'tenant-1',
      'va-1',
      { id: 'u-1', email: 'a@b.c' },
      { hasVideoAssetReadPermission: false },
    );
    await controller.report('tenant-1', 'va-1', {
      userId: 'u-1',
      email: 'a@b.c',
      permissions: ['vision:read', 'video-asset:read'],
    } as never);
    expect(lab.report).toHaveBeenCalledWith('tenant-1', 'va-1', {
      hasVideoAssetReadPermission: true,
    });
  });
});
