import { PrismaClient } from '@prisma/client';
import {
  assertSeedAllowed,
  seedPermissions,
  seedPlatformModules,
} from '../src/seed/seeders';

async function main(): Promise<void> {
  assertSeedAllowed(process.env);

  const prisma = new PrismaClient();
  try {
    const permissionCount = await seedPermissions(prisma);
    const moduleCount = await seedPlatformModules(prisma);
    console.log(
      `Seed complete: ${permissionCount} permissions, ${moduleCount} platform modules.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
