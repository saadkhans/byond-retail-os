import { PrismaClient } from '@prisma/client';
import { BcryptPasswordHasher } from '../src/auth/password-hasher';
import { seedPilotSkus, shouldSeedPilotSkus } from '../src/seed/pilot-skus';
import {
  assertSeedAdminPasswordAllowed,
  assertSeedAllowed,
  normalizeSeedAdminEmail,
  seedPermissions,
  seedPlatformAdmin,
  seedPlatformModules,
  seedPlatformSandboxTenant,
  shouldSeedPlatformAdmin,
} from '../src/seed/seeders';
import { PLATFORM_SANDBOX_TENANT_SLUG } from '../src/tenants/platform-sandbox';

async function main(): Promise<void> {
  assertSeedAllowed(process.env);

  const prisma = new PrismaClient();
  try {
    const permissionCount = await seedPermissions(prisma);
    const moduleCount = await seedPlatformModules(prisma);
    console.log(
      `Seed complete: ${permissionCount} permissions, ${moduleCount} platform modules.`,
    );

    // Local-only platform admin: requires the EXPLICIT SEED_PLATFORM_ADMIN
    // opt-in in addition to the credentials — catalog seeding can never
    // create an administrator by accident. The password itself is never
    // printed or stored — only its bcrypt hash reaches the database.
    const adminGate = shouldSeedPlatformAdmin(process.env);
    if (adminGate.seed) {
      const adminPassword = process.env.SEED_ADMIN_PASSWORD as string;
      // Fail fast if the credential or email could never pass login
      // validation — never create an account that cannot sign in.
      assertSeedAdminPasswordAllowed(adminPassword);
      const email = normalizeSeedAdminEmail(
        process.env.SEED_ADMIN_EMAIL ?? 'admin@byond.local',
      );
      const passwordHash = await new BcryptPasswordHasher().hash(
        adminPassword,
      );
      await seedPlatformAdmin(prisma, { email, passwordHash });
      console.log(`Platform admin ready: ${email}`);

      // The sandbox tenant is the ONE tenant platform users resolve to on
      // tenant-scoped routes (server-side, by fixed slug — see
      // src/tenants/platform-sandbox.ts). Seeded only together with the
      // platform admin: without the explicit opt-in above, no sandbox
      // exists and platform users keep failing closed on tenant routes.
      const sandbox = await seedPlatformSandboxTenant(prisma);
      console.log(
        `Platform sandbox tenant ready: ${PLATFORM_SANDBOX_TENANT_SLUG} ` +
          `(${sandbox.moduleCount} active modules provisioned).`,
      );
    } else {
      console.log(`Skipping platform admin seed: ${adminGate.reason}.`);
    }

    // Phase 12 — pilot SKU assortment (dev/demo only, explicit opt-in).
    // Reference images must flow through the SAME screened upload funnel
    // as the admin UI, so this branch boots the real application context
    // (fusion-shadow-run.ts precedent) instead of re-implementing the
    // screens. Dynamic imports keep the default seed path light.
    const pilotGate = shouldSeedPilotSkus(process.env);
    if (pilotGate.seed) {
      const { NestFactory } = await import('@nestjs/core');
      const { AppModule } = await import('../src/app.module');
      const { ReferenceImagesService } = await import(
        '../src/pickup-detection/reference-images.service'
      );
      const app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
      });
      try {
        const referenceImages = app.get(ReferenceImagesService);
        const pilot = await seedPilotSkus(prisma, {
          upload: (tenantId, productId, file) =>
            referenceImages.upload(tenantId, productId, file),
        });
        console.log(
          `Pilot SKUs ready: ${pilot.products} products, ` +
            `${pilot.referenceUploads} reference uploads (checksum-deduped) ` +
            `in tenant ${pilot.tenantId}.`,
        );
      } finally {
        await app.close();
      }
    } else {
      console.log(`Skipping pilot SKU seed: ${pilotGate.reason}.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
