import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { VideoAssetsController } from './video-assets.controller';
import { VideoCropsController } from './video-crops.controller';

/**
 * Pins the declarative access policy: every video-ingest route is
 * tenant-only, gated on the `video-ingest` module (ModuleEnabledGuard fails
 * closed for disabled tenants), and each handler requires its
 * least-privilege permission. The guards themselves are covered by
 * guards.spec / module-enabled.guard.spec; this spec fails if a route ever
 * loses (or broadens) its policy metadata.
 */
describe('VideoAssetsController access policy', () => {
  it('is tenant-only and gated on the video-ingest module at the class level', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, VideoAssetsController)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(REQUIRED_MODULE_KEY, VideoAssetsController),
    ).toBe('video-ingest');
  });

  it.each([
    ['upload', ['video-asset:manage']],
    ['list', ['video-asset:read']],
    ['findById', ['video-asset:read']],
    ['listArtifacts', ['video-asset:read']],
    ['validate', ['video-asset:process']],
    ['extractFrames', ['video-asset:process']],
    ['createCrop', ['video-asset:process']],
    ['delete', ['video-asset:delete']],
  ])('requires %s to hold %p', (handler, permissions) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VideoAssetsController.prototype[
          handler as keyof VideoAssetsController
        ],
      ),
    ).toEqual(permissions);
  });

  it('exposes no public route (default-deny: every handler carries permissions)', () => {
    const handlers = Object.getOwnPropertyNames(
      VideoAssetsController.prototype,
    ).filter((name) => name !== 'constructor');
    for (const name of handlers) {
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          VideoAssetsController.prototype[
            name as keyof VideoAssetsController
          ],
        ),
      ).toBeDefined();
    }
  });
});

describe('VideoCropsController access policy', () => {
  it('is tenant-only and gated on the video-ingest module at the class level', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, VideoCropsController)).toBe(
      true,
    );
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, VideoCropsController)).toBe(
      'video-ingest',
    );
  });

  it.each([
    ['findById', ['video-asset:read']],
    ['createInferenceJob', ['video-asset:process']],
  ])('requires %s to hold %p', (handler, permissions) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VideoCropsController.prototype[handler as keyof VideoCropsController],
      ),
    ).toEqual(permissions);
  });

  it('exposes no public route (default-deny: every handler carries permissions)', () => {
    const handlers = Object.getOwnPropertyNames(
      VideoCropsController.prototype,
    ).filter((name) => name !== 'constructor');
    for (const name of handlers) {
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          VideoCropsController.prototype[
            name as keyof VideoCropsController
          ],
        ),
      ).toBeDefined();
    }
  });
});
