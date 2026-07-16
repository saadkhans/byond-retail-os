# @byond/api — Core Platform API

The BYOND cloud control plane: tenants, users, auth + RBAC (Phase 2), stores/locations, platform modules, the append-only audit log, product catalog + inventory ledger (Phase 3), retail units, devices, and the edge-registration foundation (Phase 4), checkout sessions + orders (Phase 5), and the provider-neutral payment abstraction + reconciliation foundation (Phase 6). NestJS 11 + TypeScript strict + Prisma + PostgreSQL.

### Phase 6 — payments & reconciliation (foundation only)

Phase 6 introduces a **provider-neutral** payment abstraction. It deliberately does **not** integrate a live payment gateway:

- **No live gateway / no provider SDK.** There is no MyFatoorah/Stripe/Tap/HyperPay/Moyasar (or any) SDK. `provider` is a generic enum (`SIMULATED`/`MANUAL`); real gateway adapters plug in through this abstraction later.
- **Authorization and capture are SIMULATED** through an explicit payment state machine (`CREATED → REQUIRES_AUTHORIZATION → AUTHORIZED → CAPTURE_PENDING → CAPTURED`, plus `FAILED`/`CANCELLED`/`VOIDED`/`EXPIRED`). Invalid transitions are rejected, terminal states are protected, and every mutation is audited.
- **No raw card data or secrets, ever.** Only opaque provider references and **safe** card metadata are stored — `instrumentBrand`, `instrumentLast4` (exactly four digits, DB-enforced), `instrumentExpiryMonth/Year`, `instrumentWallet`. Raw PAN, CVV, PIN, magnetic-track data, provider secret keys, bearer tokens, API keys, and raw webhook secrets/payloads are **never** accepted, stored, logged, or audited (screened by `common/sensitive-keys`).
- **Order is not "paid" unless the payment reaches CAPTURED.** A captured intent is the only path that flips a linked order's `paymentStatus` to `PAID`; a failure/void never marks an order paid, and a `PAID` order is never downgraded. Refunds are reserved (`REFUND_PENDING`/`REFUNDED`) but **not** implemented — no money movement.
- **Idempotency & duplicate-capture safety.** Create/authorize/capture carry tenant-scoped idempotency keys; a duplicate capture with the same key **never** moves money twice. Provider events are deduplicated per `(tenant, provider, providerEventId)`.
- **Provider events are an ingestion FOUNDATION** — authenticated/admin-only (`POST /payment-events/simulate`), **not** a public webhook. Only normalized fields are stored (no raw payload, no signature verification yet).
- **Reconciliation is a FOUNDATION** — a `PENDING` record is seeded on capture, with read models and a manual status update. No settlement accounting, provider import, or Zoho integration.

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
- **Auth** — Phase 2: bcrypt credentials, short-lived HS256 JWTs, a global auth guard, and a permissions guard that audits every denial. Tenant context comes exclusively from the authenticated user — a `tenantId` in any request body is rejected by the global whitelist `ValidationPipe`.
- **Stores / units / devices (Phase 4)** — the `Location` entity is the store/branch/site concept, served under both `/locations` and `/stores`. `RetailUnit` (smart fridge/shelf/kiosk/... with a DRAFT→ACTIVE→MAINTENANCE/DISABLED→RETIRED lifecycle) belongs to a store; `Device` (camera/lock/sensor/... with per-tenant-unique serials, heartbeats, and `lastSeenAt`) belongs to a unit. Composite same-tenant FKs in migration SQL make cross-tenant references impossible even if an unscoped id slipped through code. Deletion is Restrict-guarded: stores with units/inventory and units with devices return controlled 409s.
- **Edge registration (Phase 4)** — `POST /devices/:id/registration-token` (permission `device:register`) issues a one-time token whose **SHA-256 hash alone** is stored; the plaintext is returned once and never logged or audited. The unauthenticated `POST /edge/register` redeems it (serial-bound, single-use, 60-minute expiry; every failure is the same generic 401). Phase 7 will exchange this registration for long-lived edge credentials — none are minted today.
- **Checkout sessions + orders (Phase 5)** — tenant-scoped checkout sessions (`OPEN → ACTIVE → PENDING_REVIEW → COMPLETED/CANCELLED/EXPIRED`) belong to a store and retail unit, carry basket lines with immutable product snapshots (sku/name/UoM/quantity), and complete atomically into a `CONFIRMED` order in a single transaction: per-line `SALE` inventory movements (conditional decrement, `referenceType='Order'`) either all succeed or the whole completion — order included — rolls back. Order numbers are unique per tenant (`ORD-000001`); duplicate completion is prevented by tenant-scoped idempotency keys that replay the original result. **No payment capture exists in Phase 5** — pricing/totals columns are nullable placeholders and no order state means "paid"; payments arrive in a later phase.
- **Vendor-neutral evidence lineage (Phase 5)** — sessions, basket lines, and order lines carry generic evidence/source reference fields (`sourceType`, `sourceId`, `evidenceBundleId`, `visionEventId`, `vlmReviewId`, `evidenceScore`, `evidenceQuality`, `reasonCodes`). These are placeholders so future CV/VLM adapters can plug in through normalized contracts — the core contains no camera, model, or vendor-specific code, and every automated line stays traceable to evidence or a manual/admin action.

## Environment variables

See [.env.example](.env.example). `DATABASE_URL` and `JWT_SECRET` are required; `PORT` (default 3000), `CORS_ORIGINS` (default `http://localhost:5173`, the admin web dev server), and `NODE_ENV` are optional. Never commit a real `.env`.
