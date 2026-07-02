import { PERMISSION_CATALOG } from '../access-control/permission.catalog';
import {
  DEFAULT_ENABLED_MODULE_CODES,
  PLATFORM_MODULE_CATALOG,
} from '../platform-modules/platform-module.catalog';
import {
  assertSeedAllowed,
  seedPermissions,
  seedPlatformModules,
} from './seeders';

describe('permission catalog', () => {
  it('has unique codes', () => {
    const codes = PERMISSION_CATALOG.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses the resource:action code format', () => {
    for (const permission of PERMISSION_CATALOG) {
      expect(permission.code).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });
});

describe('platform module catalog', () => {
  it('has unique codes', () => {
    const codes = PLATFORM_MODULE_CATALOG.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('enables only the core module by default', () => {
    expect(DEFAULT_ENABLED_MODULE_CODES).toEqual(['core']);
  });

  it('lists later-phase modules as catalog names only', () => {
    const codes = PLATFORM_MODULE_CATALOG.map((m) => m.code);
    for (const expected of ['inventory', 'pricing', 'checkout', 'cv', 'esl']) {
      expect(codes).toContain(expected);
    }
  });
});

describe('seedPermissions', () => {
  it('upserts every catalog entry keyed by unique code', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const count = await seedPermissions({ permission: { upsert } });

    expect(count).toBe(PERMISSION_CATALOG.length);
    expect(upsert).toHaveBeenCalledTimes(PERMISSION_CATALOG.length);
    for (const permission of PERMISSION_CATALOG) {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: permission.code } }),
      );
    }
  });

  it('is idempotent: a second run issues the same upserts, never bare creates', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const db = { permission: { upsert } };

    await seedPermissions(db);
    await seedPermissions(db);

    expect(upsert).toHaveBeenCalledTimes(PERMISSION_CATALOG.length * 2);
    // Every call is an upsert with a unique-key where clause — duplicates are
    // structurally impossible regardless of how often the seed runs.
    for (const call of upsert.mock.calls) {
      expect(call[0].where.code).toBeDefined();
    }
  });

  it('propagates database errors instead of swallowing them', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      seedPermissions({ permission: { upsert } }),
    ).rejects.toThrow('db down');
  });
});

describe('seedPlatformModules', () => {
  it('upserts every catalog entry keyed by unique code', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const count = await seedPlatformModules({ platformModule: { upsert } });

    expect(count).toBe(PLATFORM_MODULE_CATALOG.length);
    expect(upsert).toHaveBeenCalledTimes(PLATFORM_MODULE_CATALOG.length);
    for (const platformModule of PLATFORM_MODULE_CATALOG) {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: platformModule.code } }),
      );
    }
  });

  it('never writes tenant-scoped rows', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    await seedPlatformModules({ platformModule: { upsert } });
    for (const call of upsert.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('tenantId');
    }
  });
});

describe('assertSeedAllowed', () => {
  it('allows seeding outside production', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });

  it('refuses to seed production without an explicit override', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(
      /Refusing to seed/,
    );
  });

  it('allows production seeding only with SEED_ALLOW_PROD=true', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'production', SEED_ALLOW_PROD: 'true' }),
    ).not.toThrow();
  });
});
