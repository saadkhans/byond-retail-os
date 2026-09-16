# BYOND Retail OS

BYOND is an edge-first, cloud-managed, multitenant retail operating system. Computer vision proposes events, the inventory ledger validates them, and checkout routes the result — with human review for low-confidence events, swappable models, abstracted hardware, and enterprise-grade audit and security.

## Repository layout

```
apps/            User-facing applications
  admin-web/     Admin web console
  mobile-app/    Shopper app (mobile-first web) — entry, basket, exit, payment
services/        Backend services
  api/           Core multitenant API
  edge-runtime/  In-store edge runtime
  cv-pipeline/   Tier-1 tracking + tier-2 trigger service (proposes
                 moments; product identity stays in the API)
packages/        Shared workspace packages
  shared/        Shared types and utilities
  config/        Shared lint/TS/build configuration
  ui/            Shared UI components
ml/              CV training dataset + model pipeline (Phase 8) — schemas
                 and scripts only; datasets/weights external
infra/           Infrastructure
  docker/        Dockerfiles, nginx config and the local compose stack
  github-actions/ Reusable composite actions used by the workflows
  semgrep/       Static-analysis rules for this repo's hard rules
  scripts/       security:scan and security:secrets entry points
docs/            Documentation (architecture, product, security)
scripts/         Repo automation scripts
```

## Key documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — system principles and design invariants
- [AGENTS.md](AGENTS.md) — AI agent roles and hard rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch, PR, and review workflow
- [SECURITY.md](SECURITY.md) — security requirements and tooling
- [TESTING.md](TESTING.md) — required test categories
- [docs/development/docker.md](docs/development/docker.md) — running the stack in containers
- [docs/development/ci-and-security.md](docs/development/ci-and-security.md) — CI jobs and security scanning
- [docs/product/pricing.md](docs/product/pricing.md) — versioned pricing model and rules
- [docs/product/store-flow.md](docs/product/store-flow.md) — the autonomous store loop: entry, the observation → basket bridge, exit settlement
- [docs/product/returns.md](docs/product/returns.md) — the reverse flow: returns, refunds, cycle counts and shrink, all through the ledger
- [docs/product/esl.md](docs/product/esl.md) — vendor-neutral electronic shelf labels
- [docs/product/loyalty.md](docs/product/loyalty.md) — loyalty points and promotions that compose on top of a price version
- [docs/product/procurement.md](docs/product/procurement.md) — suppliers, purchase orders, and receiving through the inventory ledger
- [docs/product/shopper-app.md](docs/product/shopper-app.md) — the shopper application: the journey-scoped credential, the four screens, and what makes a public API surface safe

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
inventory; versioned price books (create a draft, set prices, activate, roll
back — see [docs/product/pricing.md](docs/product/pricing.md)); procurement
(suppliers and their costs, purchase orders, and receiving a delivery, which
admits stock through the append-only inventory ledger — see
[docs/product/procurement.md](docs/product/procurement.md)); and a manual
checkout test flow: create a checkout session, manage basket lines, and
complete it into an order, which now carries a total derived from the price
each line was added at. The Store flow page drives the Phase 26 loop end to end
— set a store's autonomy level (SHADOW by default, which changes nothing),
issue an entry credential, watch observations become basket lines, work one
review queue, and exit the shopper into an order and a payment (see
[docs/product/store-flow.md](docs/product/store-flow.md)). The Returns &
reconciliation page drives the Phase 27 reverse flow — record a return or
cancel a settled order (goods back into stock as ledger movements, then a
refund bounded by what was captured), run a cycle count or stocktake that
reconciles the projection against the ledger, and write off a CV-detected loss
(see [docs/product/returns.md](docs/product/returns.md)). Shelf labels are
managed under **Shelf labels**, where a gateway is registered against a
simulated (or real) vendor adapter and its labels follow every price
activation — see [docs/product/esl.md](docs/product/esl.md). **Loyalty &
promotions** covers member accounts with an append-only points ledger and
versioned promotions that subtract from the price version in force without
ever rewriting it — the quote panel there names the price version and the
promotion version behind any price, see
[docs/product/loyalty.md](docs/product/loyalty.md). The API's CORS allowlist
defaults to
`http://localhost:5173` (override with `CORS_ORIGINS`).

### Shopper app (http://localhost:5174)

```bash
cd apps/mobile-app
cp .env.example .env        # VITE_API_BASE_URL, defaults to localhost:3000
pnpm run dev
```

The shopper app is the customer-facing half of the Phase 26 loop: redeem the
entry code from the door, watch the basket fill, walk out, and see what the
payment did. It holds a journey-scoped credential rather than a staff token,
so it can reach exactly one journey and nothing else, and it collects no card
data of any kind — payment goes through the API's simulated provider
abstraction (see
[docs/product/shopper-app.md](docs/product/shopper-app.md)). Under the default
SHADOW policy the basket stays empty on purpose, and the app says so. Add its
origin to the API's allowlist when running both:
`CORS_ORIGINS=http://localhost:5173,http://localhost:5174`.

### CV pipeline (http://localhost:3100)

```bash
cd services/cv-pipeline
cp .env.example .env        # set CV_PIPELINE_API_TOKEN and CV_PIPELINE_ZONES
pnpm run start
```

Watches one camera, tracks motion on a downscaled stream, and creates an
inference job for each moment worth a heavy model. The defaults need no camera,
no ffmpeg and no model weights. See
[docs/cv/cv-pipeline-service.md](docs/cv/cv-pipeline-service.md).

### ML pipeline (Phase 8)

`ml/` is a foundation for preparing CV training datasets and mapping model
output onto the Phase 7 `POST /vision-events` API — see
[ml/README.md](ml/README.md). Datasets and trained models are external
artifacts and are never committed; this repo stores pipeline code and
schemas only.

```bash
pnpm run ml:test
python ml/scripts/prepare_rpc.py --input ml/datasets/rpc/raw --output ml/datasets/rpc/processed --dry-run
```
