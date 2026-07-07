import { isEmail } from 'class-validator';
import { PERMISSION_CATALOG } from '../access-control/permission.catalog';
import {
  exceedsPasswordByteLimit,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from '../auth/password-hasher';
import { PLATFORM_MODULE_CATALOG } from '../platform-modules/platform-module.catalog';

/**
 * Structural client types so seeders are unit-testable with simple mocks and
 * usable with both PrismaClient and transaction clients.
 */
export interface PermissionSeedClient {
  permission: {
    upsert(args: {
      where: { code: string };
      update: { description: string; module: string };
      create: { code: string; description: string; module: string };
    }): Promise<unknown>;
  };
}

export interface PlatformModuleSeedClient {
  platformModule: {
    upsert(args: {
      where: { code: string };
      update: { name: string; description: string; isActive: boolean };
      create: {
        code: string;
        name: string;
        description: string;
        isActive: boolean;
      };
    }): Promise<unknown>;
  };
}

/**
 * Idempotent by construction: upsert keyed on the unique `code`. Only global
 * (platform-owned) rows are seeded here — never tenant-scoped data.
 */
export async function seedPermissions(
  db: PermissionSeedClient,
): Promise<number> {
  for (const permission of PERMISSION_CATALOG) {
    await db.permission.upsert({
      where: { code: permission.code },
      update: {
        description: permission.description,
        module: permission.module,
      },
      create: {
        code: permission.code,
        description: permission.description,
        module: permission.module,
      },
    });
  }
  return PERMISSION_CATALOG.length;
}

export async function seedPlatformModules(
  db: PlatformModuleSeedClient,
): Promise<number> {
  // isActive is owned by the code catalog on both create AND update, so
  // re-seeding activates a module exactly when the phase that implements it
  // ships — unimplemented modules stay inactive no matter how often seeds run.
  for (const platformModule of PLATFORM_MODULE_CATALOG) {
    await db.platformModule.upsert({
      where: { code: platformModule.code },
      update: {
        name: platformModule.name,
        description: platformModule.description,
        isActive: platformModule.isActive,
      },
      create: {
        code: platformModule.code,
        name: platformModule.name,
        description: platformModule.description,
        isActive: platformModule.isActive,
      },
    });
  }
  return PLATFORM_MODULE_CATALOG.length;
}

export function assertSeedAllowed(env: {
  NODE_ENV?: string;
  SEED_ALLOW_PROD?: string;
}): void {
  if (env.NODE_ENV === 'production' && env.SEED_ALLOW_PROD !== 'true') {
    throw new Error(
      'Refusing to seed a production database. Set SEED_ALLOW_PROD=true to override deliberately.',
    );
  }
}

export const PLATFORM_ADMIN_ROLE_NAME = 'Platform Administrator';

/**
 * Platform-admin bootstrap requires its OWN explicit opt-in
 * (SEED_PLATFORM_ADMIN=true) on top of the credentials — a routine catalog
 * `db:seed` with a stray SEED_ADMIN_PASSWORD in the environment must never
 * silently create a full platform administrator. In production the general
 * seed guard (SEED_ALLOW_PROD) applies additionally.
 */
export function shouldSeedPlatformAdmin(env: {
  SEED_PLATFORM_ADMIN?: string;
  SEED_ADMIN_PASSWORD?: string;
}): { seed: boolean; reason: string } {
  const optedIn = env.SEED_PLATFORM_ADMIN === 'true';
  const hasPassword = Boolean(env.SEED_ADMIN_PASSWORD);
  if (optedIn && hasPassword) {
    return { seed: true, reason: 'SEED_PLATFORM_ADMIN=true and password provided' };
  }
  if (!optedIn && hasPassword) {
    return {
      seed: false,
      reason:
        'SEED_ADMIN_PASSWORD is set but SEED_PLATFORM_ADMIN is not "true" — ' +
        'refusing to bootstrap a platform admin without the explicit opt-in',
    };
  }
  if (optedIn && !hasPassword) {
    return {
      seed: false,
      reason:
        'SEED_PLATFORM_ADMIN=true but SEED_ADMIN_PASSWORD is not set — ' +
        'no admin created',
    };
  }
  return {
    seed: false,
    reason:
      'platform admin seeding not requested (set SEED_PLATFORM_ADMIN=true ' +
      'and SEED_ADMIN_PASSWORD to create one locally)',
  };
}

/**
 * Trims, lowercases, and validates the seed admin email with THE SAME
 * validator LoginDto's @IsEmail() uses (class-validator's isEmail), so the
 * two policies cannot drift — including edge cases a hand-rolled regex
 * misses, like consecutive dots (admin@example..com). Throws before any
 * account is created, so the seed can never report "Platform admin ready"
 * for an account that could not sign in.
 */
export function normalizeSeedAdminEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!isEmail(email)) {
    throw new Error(
      'SEED_ADMIN_EMAIL is not a valid email address — the seeded admin could never pass login validation',
    );
  }
  return email;
}

/**
 * Mirrors the login password policy (LoginDto + bcrypt byte limit): a seeded
 * admin whose password fails POST /auth/login validation could never sign
 * in. Called with the PLAINTEXT before hashing — never logged or stored.
 */
export function assertSeedAdminPasswordAllowed(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters ` +
        '(login policy) — the seeded admin could otherwise never sign in',
    );
  }
  if (exceedsPasswordByteLimit(password)) {
    throw new Error(
      `SEED_ADMIN_PASSWORD exceeds the ${MAX_PASSWORD_BYTES}-byte UTF-8 limit ` +
        'of the hashing algorithm',
    );
  }
}

export interface PlatformAdminSeedClient {
  role: {
    findFirst(args: {
      where: { tenantId: null; name: string };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: {
        tenantId: null;
        name: string;
        description: string;
        isSystem: true;
      };
    }): Promise<{ id: string }>;
  };
  permission: {
    findMany(): Promise<{ id: string; code: string }[]>;
  };
  rolePermission: {
    upsert(args: {
      where: {
        roleId_permissionId: { roleId: string; permissionId: string };
      };
      update: Record<string, never>;
      create: { roleId: string; permissionId: string };
    }): Promise<unknown>;
  };
  user: {
    findUnique(args: {
      where: { email: string };
      select: { id: true; userType: true; status: true; tenantId: true };
    }): Promise<{
      id: string;
      userType: string;
      status: string;
      tenantId: string | null;
    } | null>;
    count(args: {
      where: { email: string; passwordHash: { not: null } };
    }): Promise<number>;
    create(args: {
      data: {
        email: string;
        firstName: string;
        lastName: string;
        userType: 'PLATFORM';
        status: 'ACTIVE';
        tenantId: null;
        passwordHash: string;
      };
    }): Promise<{ id: string }>;
  };
  userRole: {
    upsert(args: {
      where: { userId_roleId: { userId: string; roleId: string } };
      update: Record<string, never>;
      create: { userId: string; roleId: string; tenantId: null };
    }): Promise<unknown>;
  };
}

/**
 * Local-development platform admin. Receives an ALREADY-HASHED credential —
 * this function never sees or stores plaintext. Idempotent for a HEALTHY
 * existing admin (rows left untouched; a reseed never overwrites a
 * password) — but if the email already belongs to an account that could not
 * actually sign in as a platform admin (tenant user, non-ACTIVE, or without
 * a local credential), the seed FAILS instead of reporting it ready.
 */
export async function seedPlatformAdmin(
  db: PlatformAdminSeedClient,
  input: { email: string; passwordHash: string },
): Promise<{ userId: string; roleId: string }> {
  const existingRole = await db.role.findFirst({
    where: { tenantId: null, name: PLATFORM_ADMIN_ROLE_NAME },
  });
  const role =
    existingRole ??
    (await db.role.create({
      data: {
        tenantId: null,
        name: PLATFORM_ADMIN_ROLE_NAME,
        description: 'Full platform access (system role).',
        isSystem: true,
      },
    }));

  const permissions = await db.permission.findMany();
  for (const permission of permissions) {
    await db.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  // Identity/status checks use a safe select; credential presence is checked
  // with a filtered count so the hash value is never materialized outside
  // AuthRepository.
  const existing = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, userType: true, status: true, tenantId: true },
  });
  if (existing) {
    const problems = [];
    if (existing.userType !== 'PLATFORM' || existing.tenantId !== null) {
      problems.push('it belongs to a tenant user, not a platform user');
    }
    if (existing.status !== 'ACTIVE') {
      problems.push(`its status is ${existing.status}, not ACTIVE`);
    }
    const credentialed = await db.user.count({
      where: { email: input.email, passwordHash: { not: null } },
    });
    if (credentialed === 0) {
      problems.push('it has no local credential (passwordless)');
    }
    if (problems.length > 0) {
      throw new Error(
        `SEED_ADMIN_EMAIL already belongs to an account that cannot act as ` +
          `the platform admin: ${problems.join('; ')}. Use a different ` +
          `SEED_ADMIN_EMAIL or fix the existing account manually.`,
      );
    }
  }
  const user =
    existing ??
    (await db.user.create({
      data: {
        email: input.email,
        firstName: 'Platform',
        lastName: 'Admin',
        userType: 'PLATFORM',
        status: 'ACTIVE',
        tenantId: null,
        passwordHash: input.passwordHash,
      },
    }));

  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id, tenantId: null },
  });

  return { userId: user.id, roleId: role.id };
}
