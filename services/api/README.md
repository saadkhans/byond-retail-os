# @byond/api — Core Platform API

Phase 1 of the BYOND cloud control plane: tenants, users, RBAC, locations, platform modules, and the append-only audit log. NestJS 11 + TypeScript strict + Prisma + PostgreSQL.

## Prerequisites

- Node 22 (`corepack enable` for pnpm)
- PostgreSQL 16 for local development (not needed to run the test suite):

```bash
docker run --name byond-postgres \
  -e POSTGRES_USER=byond -e POSTGRES_PASSWORD=byond -e POSTGRES_DB=byond_dev \
  -p 5432:5432 -d postgres:16
```

## Setup

```bash
# From the repo root
pnpm install

# From services/api
cp .env.example .env           # then adjust if your Postgres differs
pnpm run prisma:generate       # generate the Prisma client (no DB needed)
pnpm run prisma:migrate        # apply migrations (needs DB)
pnpm run db:seed               # seed default permissions + platform modules
pnpm run start:dev             # http://localhost:3000, Swagger at /docs
```

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm run lint` | ESLint over `src`, `test`, `prisma` |
| `pnpm run typecheck` | Prisma generate + `tsc --noEmit` (strict) |
| `pnpm run test` | Prisma generate + Jest (unit + e2e, **no database required**) |
| `pnpm run build` | Prisma generate + `nest build` |
| `pnpm run db:seed` | Idempotent seed; refuses `NODE_ENV=production` unless `SEED_ALLOW_PROD=true` |

All four also run from the repo root via `pnpm run lint|typecheck|test|build`.

## Architecture notes

- **Tenant isolation** — every tenant-scoped repository extends [`TenantScopedRepository`](src/prisma/tenant-scoped.repository.ts): all methods take `tenantId` first and merge it into every query; a blank tenantId throws, never wildcards. Platform-scoped repositories (Tenant, Permission, PlatformModule) are explicitly documented as such.
- **Platform vs tenant users** — single `User` table with a `userType` discriminator; a DB CHECK constraint enforces `PLATFORM ⇔ tenantId IS NULL`.
- **Audit log** — append-only: no update/delete service methods, a DB trigger rejects `UPDATE`/`DELETE`, and before/after snapshots pass a redaction filter.
- **Catalogs as code** — permissions ([permission.catalog.ts](src/access-control/permission.catalog.ts)) and platform modules ([platform-module.catalog.ts](src/platform-modules/platform-module.catalog.ts)) are typed constants; the seed upserts from them, so codes never drift.
- **No auth yet** — credentials, JWT, and the permissions guard land in Phase 2; only `health` and `tenants` expose controllers.

## Environment variables

See [.env.example](.env.example). `DATABASE_URL` is required; `PORT` (default 3000) and `NODE_ENV` are optional. Never commit a real `.env`.
