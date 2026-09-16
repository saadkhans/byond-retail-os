# TESTING.md — Required Test Categories

Every feature PR must include tests from the categories relevant to what it touches. CI runs the full suite on every PR and push to `main`/`dev`.

## Required tests

### Unit tests
Every module with logic gets unit tests. Fast, isolated, no I/O.

### Integration tests
Cross-module behavior with real (or containerized) dependencies — database, queues, adapters.

### API tests
Every API endpoint: happy path, validation errors, authz failures, and tenant-scoping.

### E2E tests
Critical user journeys through the real stack. Both named journeys now exist:

- **Shopper entry → pick → checkout.** Driven end to end by `services/api/src/store-flow/store-flow.service.spec.ts` (entry credential, the observation → basket bridge, the review queue, exit and settlement) and `services/api/src/shopper/shopper.service.spec.ts` (the same loop seen through the journey-scoped shopper credential), with the client half in `apps/mobile-app/src/shopper-flow.spec.ts` and the checkout tail over HTTP in `services/api/test/checkout-orders.e2e-spec.ts`. **Caveat:** unlike the ESL journey, this one has no single suite that drives the whole loop over HTTP through the real `AppModule`. Writing `services/api/test/store-flow-journey.e2e-spec.ts` is open work.
- **Admin price change → ESL update.** `services/api/test/esl-price-propagation.e2e-spec.ts` drives the real `AppModule` over HTTP — real guards, real `PricingService`, the real `PriceActivationHub` subscription made at bootstrap, the real `EslService` and the real simulated vendor adapter; only `PrismaService` is replaced by a deterministic in-memory fixture. `services/api/src/esl/price-change-to-label.spec.ts` covers the same journey at service level.

E2E suites in this repo deliberately run against an in-memory Prisma fixture rather than a live database, so the journeys are provable in CI. That is a trade: see the migration caveat under **Conventions**.

### Tenant isolation tests
For every tenant-scoped query and endpoint: prove tenant A can never read or mutate tenant B's data. Required for any PR touching data access.

### Inventory ledger tests
Prove all stock changes flow through the ledger, projections match ledger replay, and no code path silently overwrites stock. Required for any PR touching inventory.

### Pricing tests
Prove price changes create versions, carry audit metadata, and are reversible via rollback. Required for any PR touching pricing.

### Payment flow tests
Prove payment flows work end-to-end with tokenized data only, and that no raw card data is ever persisted or logged. Required for any PR touching payments.

### Security tests
RBAC enforcement (default deny), token TTL/single-use behavior, audit-log emission on state changes, and secret handling.

### Edge runtime tests
Offline operation, cloud-sync reconciliation, and hardware-adapter behavior under disconnect/reconnect. `services/edge-runtime` is a real service now: its suite covers the file-backed store, ledger replay against the cached projection, outbox ordering and at-least-once delivery, the tenant seal, the offline decision path and review queue, and every simulated hardware driver. `services/edge-runtime/src/sync/stock-authority.spec.ts` pins the rule that nothing under `src/sync` may write the ledger.

### Guard tests
A guard that scans source, schema or a type is only worth its runtime if it can fail. Every such guard must include a test that **injects the violation it claims to catch and asserts the guard rejects it** — a guard that only ever sees clean input proves nothing. Three guards in this repo were found passing vacuously before they were fixed; see `docs/product/release-pr.md` for what went wrong and why the fix is a negative case rather than a re-read.

### CV event validation tests
Prove CV proposals are validated against inventory before being applied, low-confidence events route to human review, and no CV output is trusted as ground truth directly.

## Conventions

- Tests live next to the code they cover (or in each package's `test/` directory).
- `pnpm run test` at the root runs everything; CI must be green before review. On a developer machine prefer per-package runs with a worker cap — `pnpm --filter @byond/api run test --ci --maxWorkers=4` — because a bare recursive run spawns a Jest worker pool per package and will exhaust a 16 GB machine.
- Every workspace package has a real suite; there are no placeholder test scripts left. As of this release: API 199 suites / 4871 tests, admin-web 23 files / 328 tests, mobile-app 3 / 58, edge-runtime 18 / 196, cv-pipeline 12 / 192, ui 1 / 5, shared 1 / 87.
- **Migrations are not covered by any of this.** `services/api/src/prisma/migration-hardening.spec.ts` asserts against migration SQL *as text*; no suite applies the migration chain to a live PostgreSQL. `pnpm --filter @byond/api run prisma:migrate-deploy` against a real database is a manual release gate.
