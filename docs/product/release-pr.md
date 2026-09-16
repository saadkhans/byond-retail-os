# Release: `dev` → `main`

Ready-to-paste description for the release pull request. Read the **What is not
proven** section before approving; it is the point of this document.

---

## What this release is

Thirteen phases (25–37). BYOND goes from a computer-vision prototype with a
multitenant API behind it to a retail operating system with a commercial half:
versioned pricing, a store loop a shopper can walk through end to end, returns
and refunds, electronic shelf labels, loyalty and promotions, reporting,
procurement, shared workspace packages, a real in-store edge runtime, a real
tier-1/tier-2 CV pipeline service, a shopper phone app behind the repository's
first public API, and infrastructure/security hardening.

Plain-language detail per phase: [release-notes.md](release-notes.md).

One rule holds throughout: **nothing mutates a figure in place.** Prices are
versions, stock is a ledger, points are a ledger, promotions are versions,
reports are derived on read.

## What changed, by area

| Area | Phase | What landed |
| --- | --- | --- |
| Pricing | 25 | Versioned price books, activation/rollback, resolution, priced basket lines and orders |
| Store loop | 26 | Entry credentials, observation → basket bridge, review queue, exit and settlement; `SHADOW` by default |
| Returns | 27 | Returns, cancellations, refunds bounded by capture, cycle counts, shrink write-offs |
| ESL | 28 | Vendor-neutral shelf labels following every price activation; simulated adapter only |
| Loyalty | 29 | Points ledger, versioned promotions composing on top of price versions, an explainable quote |
| Reporting | 30 | Seven read-only reports derived on read; no model, no cache, no job |
| Procurement | 31 | Suppliers, purchase orders, goods receipts writing the same ledger a sale does |
| Shared packages | 32 | `packages/shared`, `packages/config`, `packages/ui` |
| Edge runtime | 33 | Offline-first in-store data plane: file-backed store, local ledger, outbox sync, hardware abstraction |
| CV pipeline | 34 | Tier-1 tracking + tier-2 triggers behind swappable ports |
| Shopper app | 35 | Four-screen mobile web app on a journey-scoped credential; three public API routes |
| Infra & security | 36 | Real security scanning, container builds, reusable CI blocks |
| Documentation | 37 | This release, plus a correction pass over the top-level docs |
| Cross-cutting | — | Repo-wide tenant write-predicate hardening and a guard that walks the whole API source tree |

## Verification

Run from the repository root on the merged tree. All green.

| Command | Result |
| --- | --- |
| `pnpm -r --if-present run lint` | pass (5 pre-existing `react-hooks/exhaustive-deps` warnings, 0 errors) |
| `pnpm -r --if-present run typecheck` | pass |
| `pnpm --filter @byond/api run test --ci --maxWorkers=4` | 199 suites / 4871 tests |
| `pnpm --filter @byond/admin-web run test` | 23 files / 328 tests |
| `pnpm --filter @byond/mobile-app run test` | 3 files / 58 tests |
| `pnpm --filter @byond/edge-runtime run test --ci --maxWorkers=4` | 18 suites / 196 tests |
| `pnpm --filter @byond/cv-pipeline run test --ci --maxWorkers=4` | 12 suites / 192 tests |
| `pnpm --filter @byond/ui run test` | 1 file / 5 tests |
| `pnpm --filter @byond/shared run test` | 1 file / 87 tests |
| `pnpm -r --if-present run build` | pass (all 5 packages with a build script) |
| `prisma validate` | schema valid |

Note: `pnpm run test` at the root fans out to every package at once and will
exhaust a 16 GB machine. Use per-package runs with `--maxWorkers=4`.

---

## What is NOT proven

A release note that hides known risk is worse than none. Everything below is a
real gap in this release, ordered roughly by how much damage it can do.

### 1. The migration chain has never been applied to a live PostgreSQL — RELEASE BLOCKER

Fourteen migrations landed today (`20260916090000_phase25_pricing` through
`20260916150001_reporting_module_backfill`), on top of an existing chain of
about fifty-five. **Not one of them has been run against a real database.**

They have been verified only two ways, and both are text:

- `prisma validate` parses `schema.prisma` and says the *schema* is
  well-formed. It does not read the migrations at all.
- `services/api/src/prisma/migration-hardening.spec.ts` reads migration `.sql`
  files **as strings** and asserts that particular constraint text appears in
  them. It never executes SQL.

Every test suite in this repository runs against an in-memory Prisma double.
Nothing listens on 5432 or 5433 on the machine this was built on, and the Docker
daemon is not running, so `docker compose up` could not be used either.

What this means concretely: a migration that references a column in the wrong
order, a `CHECK` that PostgreSQL rejects, a foreign key against a table created
later in the chain, an index name longer than 63 characters, a `NOT NULL` added
to a table with existing rows and no default — none of these would have been
caught. The failure mode is a deploy that halts partway through the chain, on a
database that is now in neither the old shape nor the new one.

**Required before merge to `main`:**

```bash
# against a scratch database, from an empty schema
DATABASE_URL=... pnpm --filter @byond/api run prisma:migrate-deploy
DATABASE_URL=... pnpm --filter @byond/api run db:seed
# then again against a restore of production, to prove the chain
# applies forward from the shape production is actually in
```

Both runs matter. A chain that works from empty can still fail forward from a
populated database.

### 2. Two migration timestamp collisions — order is safe by luck, not design

Four migrations share two timestamps:

```
20260916110000_phase27_returns_reconciliation
20260916110000_phase28_esl
20260916110001_esl_module_backfill
20260916110001_returns_module_backfill
```

Phases 27 and 28 were developed on parallel branches and both picked the same
hour. Prisma orders migrations by directory name, so it breaks the tie
lexicographically and applies them in this order:

1. `...110000_phase27_returns_reconciliation` (`phase27` < `phase28`)
2. `...110000_phase28_esl`
3. `...110001_esl_module_backfill` (`esl` < `returns`)
4. `...110001_returns_module_backfill`

That order happens to be correct — returns and ESL create independent tables,
and each module backfill lands after its own tables exist. **That is luck.** Had
the ESL backfill sorted before the ESL table creation, the deploy would fail at
step 3, and nothing in this repository would have told us in advance. There is
no guard asserting migration timestamps are unique.

**Recommendation:** renumber `phase28_esl` to `20260916111000` and
`esl_module_backfill` to `20260916111001` before the chain is ever applied to a
database that will be kept. Renumbering is free *now* and impossible *later* —
once a migration is in `_prisma_migrations` on any database you care about,
renaming its directory makes Prisma treat it as a new, unapplied migration.

If you renumber, the directory names are referenced from two files that must be updated in the same commit:

- `services/api/src/prisma/migration-hardening.spec.ts` (two string literals:
  `'20260916110000_phase27_returns_reconciliation'` and
  `'20260916110001_returns_module_backfill'`)
- `services/api/src/platform-modules/platform-module.catalog.ts` (two comments
  naming `20260916110001_returns_module_backfill` and
  `20260916110001_esl_module_backfill`)

Add a guard in the same commit: a test that reads the migrations directory and
fails on a duplicate timestamp prefix. This costs five lines and removes the
class of problem.

### 3. The first public API surface in the repository — needs a personal security review

Phase 35 adds three `@Public()` routes: `POST /shopper/session`,
`GET /shopper/basket`, `POST /shopper/exit`. Until now every route in this API
required an authenticated user or a device token.

It is guarded carefully, and the design is the right one:

- The principal changes, not the guard. A shopper presents
  `Authorization: Shopper <secret>` — the single-use store entry credential —
  matched by SHA-256 digest, authorizing exactly one journey in exactly one
  tenant.
- The client never names a tenant, store, journey or shopper. Every identifier
  is read off the credential server-side, so there is no parameter to tamper
  with.
- All three routes live in one file so the surface stays countable;
  `services/api/src/shopper/boundary.spec.ts` pins the count and
  `apps/mobile-app/src/app-safety.spec.ts` pins that the client makes no other
  call.
- No payment form, field or handler exists in the app.

What still deserves human eyes, because no test can substitute for judgement
here:

- **The credential is a bearer token that lives in a phone browser for up to
  four hours.** The entry code is single-use *for entry*, but the same secret
  then authenticates every subsequent request for the session's life. Anyone who
  observes it — over the shoulder, from a shared device, from a screenshot —
  holds the journey until it settles.
- **There is no rate limiting on the shopper routes.** `LOGIN_THROTTLE_*` guards
  `POST /auth/login`; nothing equivalent guards `POST /shopper/session`, which
  means credential-guessing is bounded only by the entropy of the secret.
- **Error shape and timing.** Verify that an invalid credential, an expired one,
  and one belonging to another tenant are indistinguishable to the caller — in
  body, status *and* response time.
- **CORS.** The API's allowlist defaults to `http://localhost:5173` only. The
  shopper app runs on 5174 and a production deployment needs its real origin
  added to `CORS_ORIGINS`. Getting this wrong fails closed (the app breaks), but
  getting it *too permissive* is the interesting direction.

Recommend running `/security-review` against `services/api/src/shopper/` and
`apps/mobile-app/` specifically, and treating Saad's sign-off as a merge gate.

### 4. The tenant write-predicate guard is textual, not semantic

`services/api/src/prisma/tenant-write-predicate.spec.ts` walks the whole API
source tree and requires every destructive Prisma write on a tenant-scoped model
to name `tenantId` inside its own `where:` predicate. It caught nine real
violations across four modules when it was written, and it has exactly one
allowlist entry (the platform admin role grant in `seed/seeders.ts`, which
genuinely has no tenant).

Its limit: **it proves the token `tenantId` is present. It cannot prove the
value bound to it is the caller's tenant.** A write reading
`where: { id, tenantId: someOtherTenantId }` passes the guard cleanly. So does
one where `tenantId` comes from a request body that a validation pipe happened
not to strip.

The proper fix is a Prisma client extension: intercept `delete`, `deleteMany`,
`update`, `updateMany` and `upsert` at the driver, and refuse any call on a
model carrying `tenantId` whose `where` does not bind the tenant from the
request context. At that layer the *value* is knowable, which is the whole
difference. This is a contained piece of work and would retire the textual guard
entirely.

### 5. `ProductBarcode` and `UserRole` lack `@@unique([id, tenantId])`

Seventy-seven of the ninety models in `schema.prisma` carry
`@@unique([id, tenantId])`, which is what lets a single-row `delete`/`update`
address a row by a unique that carries the tenant — so the *database* refuses
another tenant's row rather than relying on the application getting the
predicate right.

These two do not:

- **`ProductBarcode`** has `@@unique([tenantId, value])` but no `[id, tenantId]`.
  Today this is safe by accident: both write sites
  (`services/api/src/catalog/products.repository.ts:268` and `:335`) use
  `deleteMany` with the tenant in the filter, which does not need a composite
  unique. The risk is the next person who writes a single-row
  `productBarcode.delete({ where: { id } })` and finds it compiles.
- **`UserRole`** has only `@@unique([userId, roleId])`. It is the sole entry on
  the write-predicate allowlist for exactly this reason, and in that one case
  the natural key genuinely is correct.

Adding the composite unique to `ProductBarcode` is a one-line migration with no
data change, and it closes a footgun rather than fixing a bug. `UserRole` is
more nuanced because platform grants carry `tenantId: null`; leave it and keep
the allowlist entry, which already explains itself.

### 6. Reference-number rollover in procurement at the 10,000th document per tenant-year

`nextReference()` in `services/api/src/procurement/procurement.logic.ts:175`
builds `PREFIX-YYYY-NNNN` by finding the highest existing reference for the year
and adding one. The lookup is
`orderBy: { reference: 'desc' }` on a **string** column
(`procurement.repository.ts:958` and `:963`), so it sorts lexicographically, and
the number is zero-padded to four digits.

At the 10,000th purchase order (or goods receipt) in a tenant-year:

- `PO-2026-10000` sorts *below* `PO-2026-9999`, because `'1' < '9'`.
- So the "latest" reference stays `PO-2026-9999` forever.
- `nextReference` therefore keeps returning `PO-2026-10000`.
- The unique index on `(tenantId, reference)` rejects it, the caller retries, and
  computes the same value again.

**The result is a permanent 500 on creating any further purchase order or goods
receipt for that tenant in that year. It is never corruption** — the unique index
does its job, and no wrong row is ever written. It is a hard stop, and it
unsticks itself at New Year.

Ten thousand purchase orders in one year is a large retailer, not an absurd one.
The fix is to sort by a numeric column, or to pad to a width nothing will reach
and assert the width, or to keep a per-tenant-year counter row. Correcting the
comment above `nextReference` would also help: it explains the collision-retry
behaviour as if retry always converges, and here it cannot.

Note that `formatOrderNumber` in
`services/api/src/checkout/checkout-sessions.repository.ts:263` pads to six
digits but derives its value from a numeric sequence, so past 999,999 it simply
produces a seven-digit number. Cosmetic, not a collision.

### 7. The ESL update queue has no worker

`POST /esl/update-jobs/process` drains the queue. Nothing calls it on a timer.

This is documented behaviour, not a bug, and it is a reasonable choice for a
first release — but the operational consequence deserves stating plainly:
**activating a price version queues label pushes that will not happen until
somebody (or some cron, or some external scheduler) hits that route.** A
deployment that does not arrange for this will see prices change at checkout
while the shelf keeps showing the old number, with no error anywhere, until
someone runs `POST /esl/reconcile`.

Whatever drives it in production needs to be part of the deployment, not
discovered afterwards.

### 8. `services/api/.env.example` has lagged since Phase 4

`src/config/env.validation.ts` declares 52 keys. `.env.example` contains five:
`DATABASE_URL`, `PORT`, `NODE_ENV`, `JWT_SECRET`, `JWT_EXPIRES_IN`. Everything
added since — the `VIDEO_*` block, `TRUST_PROXY`, `CORS_ORIGINS`, the
`LOGIN_THROTTLE_*` trio, every `CV_LOCAL_*` / `CV_PRETRAINED_*` / `CV_LIVE_*` /
`PICKUP_*` flag — is missing from the file that new deployments copy.

This compounds a known trap: the config validator whitelists unknown keys, so a
variable that is not declared in `env.validation.ts` is stripped before any
module reads it. A flag set in the environment but missing from the validator is
silently dead. `services/api/README.md` now points at the validator as the
authoritative list, but `.env.example` should be regenerated from it.

### 9. The first named E2E journey has no HTTP-level suite

`TESTING.md` names two critical journeys. Only one is covered end to end through
the real `AppModule`:

- **Admin price change → ESL update** — `services/api/test/esl-price-propagation.e2e-spec.ts`
  drives real HTTP through real guards, the real `PricingService`, the real
  `PriceActivationHub` bootstrap subscription, the real `EslService` and the real
  simulated adapter. This is a genuine E2E.
- **Shopper entry → pick → checkout** — covered *at service level* by
  `services/api/src/store-flow/store-flow.service.spec.ts` and
  `services/api/src/shopper/shopper.service.spec.ts`, with the client half in
  `apps/mobile-app/src/shopper-flow.spec.ts` and the checkout tail over HTTP in
  `services/api/test/checkout-orders.e2e-spec.ts`. **There is no single suite
  that drives entry → pick → exit over HTTP through the composed application.**

The difference matters: the ESL suite is what would catch a bootstrap
subscription silently not being made. Nothing plays that role for the store
loop, which is the more complex of the two journeys and the one with a public
surface attached. `services/api/test/store-flow-journey.e2e-spec.ts` is the
missing file.

Note also that all E2E suites here substitute an in-memory Prisma double for a
live database. That is a deliberate trade for CI determinism, and it is also
why risk 1 exists.

### 10. Everything external is simulated

Worth saying once, plainly, because five separate documents each say it about
their own module and the cumulative picture is easy to miss. **No code in this
release contacts a real external system.** Not a payment gateway, not a refund
gateway, not a shelf-label vendor, not a supplier system. Every one sits behind
a port this repository owns with exactly one adapter registered, and that
adapter is simulated.

That is the correct architecture and it is what makes the whole suite runnable
in CI. It also means the entire money path and the entire hardware path are
unexercised against anything real. The first production deployment is the first
integration test for all of them at once.

### 11. Smaller findings

- **Tax does not exist anywhere in the platform.** `totalMinor` equals
  `subtotalMinor` throughout. For most retail jurisdictions this is not a
  cosmetic gap.
- **Reporting performance is unmeasured.** Every figure is derived on read, by
  design, with no cache and no materialised view. On the in-memory test double
  that is instant. Against a real ledger with millions of movements, the sales
  and balances reports are unprofiled, and because no live database was
  available, no query plan has ever been examined. The `MAX_SALES_PRICE_POINTS`
  refusal bounds the *response*, not the work done to produce it.
- **`LoyaltyAccount.shopperId` is now foreign-keyed but still never written.**
  The column, the composite same-tenant FK and the partial unique index all
  exist; no DTO field sets it. Linking a loyalty account to a shopper is
  unfinished work, not a shipped feature.
- **Procurement's "no returns to supplier" limitation forward-referenced the
  returns phase.** Phase 27 shipped and does not implement supplier returns. The
  doc has been corrected; the gap remains.
- **The shopper app's origin must be added to `CORS_ORIGINS` in any deployment
  running it.** The default allowlist is `http://localhost:5173` only.

---

## Process note: three guards were found passing vacuously

This belongs in the permanent record rather than in one session's memory,
because it is the most transferable thing learned building this release.

Three separate guards in this repository were passing while proving nothing:

1. **A type-level guard whose helper resolved to `true | never`.** Because
   `never` is absorbed in a union, the assertion was satisfied by every input,
   including the ones it existed to reject. It compiled, it was green, and it
   had no effect.
2. **A source-scanning guard with `\n` hardcoded in its regex.** Under
   `core.autocrlf=true` on Windows the working tree has `\r\n` line endings, so
   the pattern matched nothing. The guard reported zero violations because it
   found zero lines, not because the code was clean.
3. **Repository test doubles resolving `findUnique`/`update` by `where.id`
   alone.** They ignored `where.tenantId` entirely, so a test asserting that a
   cross-tenant write is refused passed whether or not the production predicate
   carried the tenant — which is precisely the bug the test was written to
   catch.

Each was green. Each had been green for some time. Each was worthless.

**The lesson, and the rule now written into `TESTING.md`: a guard is not done
until you have injected the violation it claims to catch and watched it fail.**
Re-reading the guard is not sufficient — all three of these read correctly.
Every guard needs a negative case that fails when the guard is removed, and the
negative case has to be run *before* the guard is trusted, not after something
slips past it. `tenant-write-predicate.spec.ts` now does this explicitly, in a
test named "detects an unscoped write and accepts a scoped one".

The general shape of the failure is worth naming: **a check that cannot observe
its subject reports success.** A regex that matches nothing, a type that
absorbs, a double that ignores the field under test — all three fail silently in
the passing direction. Any guard whose output is "no violations found" should be
suspected of not having looked.

---

## If this merged tomorrow

Honest assessment. The code is in good shape; the deployment is not.

**Would break immediately:** nothing, *if* the migration chain applies. That is
the whole question, and it is untested. If it does not apply, the deploy halts
partway through and leaves the database in an intermediate shape.

**Would break within the first day:** shelf labels drift silently from prices,
because nothing drains the ESL queue on a timer. The shopper app fails to load
if its production origin was not added to `CORS_ORIGINS`. A new deployment
configured from `.env.example` is missing every variable added since Phase 4.

**Would break eventually, loudly:** procurement stops accepting purchase orders
for a tenant that reaches ten thousand in a year.

**Would not break, but is unproven:** the entire money path, the entire hardware
path, and reporting performance against a real ledger.

**The one thing to do first:** run the migration chain against a scratch
database and then against a production restore, and renumber the colliding
timestamps before either of those runs makes the current names permanent.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
