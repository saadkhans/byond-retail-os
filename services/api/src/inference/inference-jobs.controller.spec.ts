import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { InferenceJobsController } from './inference-jobs.controller';

/**
 * Pins the declarative access policy: every inference route is tenant-only,
 * gated on the `inference` module (ModuleEnabledGuard fails closed for
 * disabled tenants), and each handler requires its least-privilege
 * permission. The guards themselves are covered by guards.spec /
 * module-enabled.guard.spec; this spec fails if a route ever loses (or
 * broadens) its policy metadata.
 */
describe('InferenceJobsController access policy', () => {
  it('is tenant-only and gated on the inference module at the class level', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, InferenceJobsController)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(REQUIRED_MODULE_KEY, InferenceJobsController),
    ).toBe('inference');
  });

  it.each([
    ['create', ['inference:manage']],
    ['search', ['inference:read']],
    ['findById', ['inference:read']],
    ['start', ['inference:manage']],
    ['complete', ['inference:simulate']],
    ['fail', ['inference:manage']],
    ['toVisionEvent', ['inference:apply']],
  ])('requires %s to hold %p', (handler, permissions) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        InferenceJobsController.prototype[
          handler as keyof InferenceJobsController
        ],
      ),
    ).toEqual(permissions);
  });

  it('exposes no public route (default-deny: every handler carries permissions)', () => {
    const handlers = Object.getOwnPropertyNames(
      InferenceJobsController.prototype,
    ).filter((name) => name !== 'constructor');
    for (const name of handlers) {
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          InferenceJobsController.prototype[
            name as keyof InferenceJobsController
          ],
        ),
      ).toBeDefined();
    }
  });
});
