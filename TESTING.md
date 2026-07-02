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
Critical user journeys through the real stack: shopper entry → pick → checkout; admin price change → ESL update.

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
Offline operation, cloud-sync reconciliation, and hardware-adapter behavior under disconnect/reconnect.

### CV event validation tests
Prove CV proposals are validated against inventory before being applied, low-confidence events route to human review, and no CV output is trusted as ground truth directly.

## Conventions

- Tests live next to the code they cover (or in each package's `test/` directory).
- `pnpm run test` at the root runs everything; CI must be green before review.
- Placeholder scripts stand in until the first packages land.
