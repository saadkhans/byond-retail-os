// Prisma CLI configuration (replaces the deprecated package.json#prisma
// block). Unlike the legacy mode, prisma.config.ts does NOT auto-load .env,
// so we load it explicitly for CLI commands that need DATABASE_URL.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
});
