# BYOND Retail OS

BYOND is an edge-first, cloud-managed, multitenant retail operating system. Computer vision proposes events, the inventory ledger validates them, and checkout routes the result — with human review for low-confidence events, swappable models, abstracted hardware, and enterprise-grade audit and security.

## Repository layout

```
apps/            User-facing applications
  admin-web/     Admin web console
  mobile-app/    Shopper / staff mobile app
services/        Backend services
  api/           Core multitenant API
  edge-runtime/  In-store edge runtime
  cv-pipeline/   Computer vision event pipeline
packages/        Shared workspace packages
  shared/        Shared types and utilities
  config/        Shared lint/TS/build configuration
  ui/            Shared UI components
infra/           Infrastructure
  docker/        Dockerfiles and compose configs
  github-actions/ Reusable CI building blocks
docs/            Documentation (architecture, product, security)
scripts/         Repo automation scripts
```

## Key documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — system principles and design invariants
- [AGENTS.md](AGENTS.md) — AI agent roles and hard rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch, PR, and review workflow
- [SECURITY.md](SECURITY.md) — security requirements and tooling
- [TESTING.md](TESTING.md) — required test categories

## Getting started

```bash
corepack enable
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

## Running locally

### Backend API (http://localhost:3000)

```bash
cd services/api
cp .env.example .env        # set DATABASE_URL and a real JWT_SECRET
pnpm run prisma:migrate     # apply migrations to your local Postgres
pnpm run db:seed            # seed permissions/modules (see .env.example for
                            # the local platform-admin opt-in)
pnpm run start:dev
```

- API: http://localhost:3000
- Swagger UI: http://localhost:3000/docs (non-production only)

### Admin web (http://localhost:5173)

```bash
cd apps/admin-web
cp .env.example .env        # VITE_API_BASE_URL, defaults to localhost:3000
pnpm run dev
```

The admin web signs in via `POST /auth/login` (or a pasted access token) and
provides read-only visibility over stores, units, devices, catalog, and
inventory. The API's CORS allowlist defaults to `http://localhost:5173`
(override with `CORS_ORIGINS`).
