import { PERMISSION_CATALOG } from '../access-control/permission.catalog';
import {
  DEFAULT_ENABLED_MODULE_CODES,
  PLATFORM_MODULE_CATALOG,
} from '../platform-modules/platform-module.catalog';
import {
  assertSeedAdminPasswordAllowed,
  assertSeedAllowed,
  normalizeSeedAdminEmail,
  PLATFORM_ADMIN_ROLE_NAME,
  PlatformAdminSeedClient,
  seedPermissions,
  seedPlatformAdmin,
  seedPlatformModules,
  shouldSeedPlatformAdmin,
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

  it('keeps unimplemented modules inactive: only core is active', () => {
    const active = PLATFORM_MODULE_CATALOG.filter((m) => m.isActive).map(
      (m) => m.code,
    );
    expect(active).toEqual(['core']);
  });

  it('never marks an inactive module as default-enabled', () => {
    for (const platformModule of PLATFORM_MODULE_CATALOG) {
      if (platformModule.defaultEnabled) {
        expect(platformModule.isActive).toBe(true);
      }
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

  it('seeds isActive from the catalog on both create and update paths', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    await seedPlatformModules({ platformModule: { upsert } });

    for (const platformModule of PLATFORM_MODULE_CATALOG) {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { code: platformModule.code },
          create: expect.objectContaining({
            isActive: platformModule.isActive,
          }),
          update: expect.objectContaining({
            isActive: platformModule.isActive,
          }),
        }),
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

describe('seedPlatformAdmin', () => {
  // Shape returned by the safe select — the seeder never reads the hash.
  const healthyAdmin = {
    id: 'admin-1',
    userType: 'PLATFORM',
    status: 'ACTIVE',
    tenantId: null,
  };

  let db: {
    role: { findFirst: jest.Mock; create: jest.Mock };
    permission: { findMany: jest.Mock };
    rolePermission: { upsert: jest.Mock };
    user: { findUnique: jest.Mock; count: jest.Mock; create: jest.Mock };
    userRole: { upsert: jest.Mock };
  };

  beforeEach(() => {
    db = {
      role: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'role-admin' }),
      },
      permission: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', code: 'tenant:read' },
          { id: 'p2', code: 'tenant:manage' },
        ]),
      },
      rolePermission: { upsert: jest.fn().mockResolvedValue({}) },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue({ id: 'admin-1' }),
      },
      userRole: { upsert: jest.fn().mockResolvedValue({}) },
    };
  });

  const input = { email: 'admin@byond.local', passwordHash: '$2b$12$hash' };

  function client(): PlatformAdminSeedClient {
    return db as unknown as PlatformAdminSeedClient;
  }

  it('creates the system role, grants every permission, and links the admin', async () => {
    const result = await seedPlatformAdmin(client(), input);

    expect(db.role.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: null,
        name: PLATFORM_ADMIN_ROLE_NAME,
        isSystem: true,
      }),
    });
    expect(db.rolePermission.upsert).toHaveBeenCalledTimes(2);
    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: input.email,
        userType: 'PLATFORM',
        tenantId: null,
        status: 'ACTIVE',
        passwordHash: input.passwordHash,
      }),
    });
    expect(db.userRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: 'admin-1', roleId: 'role-admin', tenantId: null },
      }),
    );
    expect(result).toEqual({ userId: 'admin-1', roleId: 'role-admin' });
  });

  it('is idempotent for a healthy existing admin: reuses rows, never overwrites', async () => {
    db.role.findFirst.mockResolvedValue({ id: 'role-existing' });
    db.user.findUnique.mockResolvedValue(healthyAdmin);

    const result = await seedPlatformAdmin(client(), input);

    expect(db.role.create).not.toHaveBeenCalled();
    // Existing user reused untouched — password never overwritten.
    expect(db.user.create).not.toHaveBeenCalled();
    expect(result.userId).toBe('admin-1');
  });

  it('fails when the email belongs to a TENANT user', async () => {
    db.user.findUnique.mockResolvedValue({
      ...healthyAdmin,
      userType: 'TENANT',
      tenantId: 'tenant-a',
    });

    await expect(seedPlatformAdmin(client(), input)).rejects.toThrow(
      /belongs to a tenant user/,
    );
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.userRole.upsert).not.toHaveBeenCalled();
  });

  it.each(['SUSPENDED', 'DEACTIVATED', 'INVITED'])(
    'fails when the existing account status is %s',
    async (status) => {
      db.user.findUnique.mockResolvedValue({ ...healthyAdmin, status });

      await expect(seedPlatformAdmin(client(), input)).rejects.toThrow(
        new RegExp(`status is ${status}, not ACTIVE`),
      );
      expect(db.userRole.upsert).not.toHaveBeenCalled();
    },
  );

  it('fails when the existing account has no local credential', async () => {
    db.user.findUnique.mockResolvedValue(healthyAdmin);
    // Credential presence comes from a filtered count, not the hash value.
    db.user.count.mockResolvedValue(0);

    await expect(seedPlatformAdmin(client(), input)).rejects.toThrow(
      /no local credential/,
    );
    expect(db.user.count).toHaveBeenCalledWith({
      where: { email: input.email, passwordHash: { not: null } },
    });
    expect(db.userRole.upsert).not.toHaveBeenCalled();
  });

  it('never selects passwordHash when looking up the existing account', async () => {
    db.user.findUnique.mockResolvedValue(healthyAdmin);

    await seedPlatformAdmin(client(), input);

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: input.email },
      select: { id: true, userType: true, status: true, tenantId: true },
    });
    const select = db.user.findUnique.mock.calls[0][0].select as Record<
      string,
      unknown
    >;
    expect(select).not.toHaveProperty('passwordHash');
  });

  it('only ever handles a hash — the seeder has no plaintext input path', async () => {
    await seedPlatformAdmin(client(), input);
    const userCreate = db.user.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(userCreate.passwordHash).toBe(input.passwordHash);
    expect(userCreate.password).toBeUndefined();
  });
});

describe('normalizeSeedAdminEmail', () => {
  it('trims and lowercases a valid email', () => {
    expect(normalizeSeedAdminEmail('  Admin@Byond.Local ')).toBe(
      'admin@byond.local',
    );
  });

  it('accepts the default seed address unchanged', () => {
    expect(normalizeSeedAdminEmail('admin@byond.local')).toBe(
      'admin@byond.local',
    );
  });

  it.each([
    'not-an-email',
    'missing-domain@',
    '@missing-local.example',
    'two words@example.com',
    'nodot@example',
    // Consecutive dots — rejected by the shared class-validator isEmail,
    // which a hand-rolled regex previously let through.
    'admin@example..com',
    'admin@.example.com',
    '',
    '   ',
  ])('rejects invalid seed email %j before any account is created', (raw) => {
    expect(() => normalizeSeedAdminEmail(raw)).toThrow(
      /SEED_ADMIN_EMAIL is not a valid email/,
    );
  });
});

describe('shouldSeedPlatformAdmin (explicit opt-in gate)', () => {
  it('seeds only when SEED_PLATFORM_ADMIN=true AND a password is provided', () => {
    expect(
      shouldSeedPlatformAdmin({
        SEED_PLATFORM_ADMIN: 'true',
        SEED_ADMIN_PASSWORD: 'local-password',
      }).seed,
    ).toBe(true);
  });

  it('a stray password WITHOUT the opt-in never creates an admin', () => {
    const gate = shouldSeedPlatformAdmin({
      SEED_ADMIN_PASSWORD: 'local-password',
    });
    expect(gate.seed).toBe(false);
    expect(gate.reason).toMatch(/explicit opt-in/);
  });

  it('the opt-in without a password creates nothing', () => {
    const gate = shouldSeedPlatformAdmin({ SEED_PLATFORM_ADMIN: 'true' });
    expect(gate.seed).toBe(false);
  });

  it.each(['TRUE', '1', 'yes', 'false', ''])(
    'opt-in value %j is not accepted (only the exact string "true")',
    (value) => {
      expect(
        shouldSeedPlatformAdmin({
          SEED_PLATFORM_ADMIN: value,
          SEED_ADMIN_PASSWORD: 'local-password',
        }).seed,
      ).toBe(false);
    },
  );

  it('does nothing when neither variable is set', () => {
    expect(shouldSeedPlatformAdmin({}).seed).toBe(false);
  });
});

describe('assertSeedAdminPasswordAllowed', () => {
  it('accepts a password that satisfies the login policy', () => {
    expect(() =>
      assertSeedAdminPasswordAllowed('valid-local-password'),
    ).not.toThrow();
    expect(() => assertSeedAdminPasswordAllowed('12345678')).not.toThrow(); // exactly 8
  });

  it('rejects passwords shorter than the login minimum (8)', () => {
    expect(() => assertSeedAdminPasswordAllowed('short7!')).toThrow(
      /at least 8 characters/,
    );
  });

  it('rejects passwords over the bcrypt 72-byte limit', () => {
    expect(() => assertSeedAdminPasswordAllowed('a'.repeat(73))).toThrow(
      /72-byte/,
    );
    // Bytes, not characters: 25 × '€' (3 bytes each) = 75 bytes.
    expect(() => assertSeedAdminPasswordAllowed('€'.repeat(25))).toThrow(
      /72-byte/,
    );
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
