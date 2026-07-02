import { PERMISSION_CATALOG } from '../access-control/permission.catalog';
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
      update: { name: string; description: string };
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
  for (const platformModule of PLATFORM_MODULE_CATALOG) {
    await db.platformModule.upsert({
      where: { code: platformModule.code },
      update: {
        name: platformModule.name,
        description: platformModule.description,
      },
      create: {
        code: platformModule.code,
        name: platformModule.name,
        description: platformModule.description,
        isActive: true,
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
