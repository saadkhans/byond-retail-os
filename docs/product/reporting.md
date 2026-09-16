# Reporting and analytics

Every phase before this one produced a record of something that happened: a
price version, an order line, a ledger movement, a cycle count, an operator's
verdict on a camera observation. Phase 30 adds the first surface that produces
no record at all. It only reads.

That is the whole design.

> **Reporting reads. It never writes domain data, and it never becomes a
> second source of truth.**

## What that rules out

A reporting module is the easiest place in a retail platform to quietly create
a second set of books. The usual route is innocent: a nightly roll-up table
because the query got slow, a cached total because the dashboard flickered, a
"corrected" figure because the raw number looked wrong. Each one creates a
number that can disagree with the ledger — and once one exists, nobody can say
which is true.

So none of them exist here:

- **No tables.** Phase 30 adds no model to `schema.prisma`. Its only migration
  activates the `reporting` platform module and seeds one permission.
- **No writes.** There is no `create`, `update`, `upsert` or `delete` anywhere
  in `services/api/src/reporting/`, and no `$transaction` and no
  `$executeRaw`. `read-only.spec.ts` greps the whole directory and fails the
  build on any of them.
- **No cache, no materialised view, no scheduled job.** Every figure is
  computed from the source rows at the moment it is asked for. The same guard
  fails on `setInterval`, `setTimeout`, `@Cron`, a cache manager, a memoiser,
  or a `CREATE`/`REFRESH MATERIALIZED` statement.
- **No saved report definitions and no free text.** The query DTOs accept a
  date window and ids. Nothing an operator types on the Reports page is ever
  persisted, which is why no field here needs screening for payment data —
  there is no field.

Because nothing is cached, "as of when" is never ambiguous. Every response
carries a provenance block:

```json
{
  "generatedAt": "2026-09-16T12:00:00.000Z",
  "derivation": "DERIVED_ON_READ",
  "sourceOfTruth": ["InventoryMovement", "InventoryLevel"],
  "stale": false
}
```

`stale` is structurally false, not hopefully false. If a materialised figure
is ever introduced, that flag has to become true and the admin page's own
wording changes with it (`asOfLabel` in `reporting-utils.ts` already renders
the other branch: *"Cached figure ... NOT live"*). A stale number can never be
shown as a live one by omission.

## The report families

| Report | Route | Derived from |
| --- | --- | --- |
| Sales | `GET /reports/sales` | `OrderLine` with `Order`, plus `PriceBookVersion` and `PromotionVersion` provenance |
| One sale, explained | `GET /reports/sales/orders/:orderId` | the same, for a single order |
| Inventory movements | `GET /reports/inventory/movements` | `InventoryMovement` |
| Inventory balances | `GET /reports/inventory/balances` | `InventoryMovement`, cross-checked against `InventoryLevel` |
| Count reconciliation | `GET /reports/inventory/count-reconciliation` | `CycleCountLine` |
| Shrink | `GET /reports/shrink` | `ShrinkEvent`, cross-checked against `SHRINK` movements |
| CV accuracy | `GET /reports/cv-accuracy` | `PilotObservationReview` |

Every route is a `GET`. The controller spec asserts that, so a write cannot be
added here without deleting a test that says why it must not be.

## A sales figure that can be traced

Phases 25, 26 and 29 put four columns on every order line for exactly this
moment: `priceBookVersionId`, `basePriceMinor`, `promotionVersionId` and
`promotionDiscountMinor`. A promotion never rewrote a price — it was recorded
as a separate, subtractive layer on top of the version in force.

The sales report is aggregated at the grain those columns make meaningful: the
**price point**, one row per

```
(product, currency, price-book version, promotion version, base price, discount, unit price)
```

collapsed by the database. From a price point the three figures follow:

```
gross    = basePriceMinor         x units      what the price version said
discount = promotionDiscountMinor x units      what the promotion took off
net      = SUM(lineTotalMinor)                 what the shopper was charged

gross - discount = net
```

That identity is asserted per currency and reported as `reconciled`. It is
never *enforced* by re-deriving one side from the other: if an order line's own
snapshot columns contradict each other the report says so
(`inconsistentPricePoints`) rather than quietly making the books balance.

Two further honesty rules:

- **Currencies are never summed.** A price book never mixes currencies, so two
  currencies in a window are two totals.
- **A truncated breakdown is refused, not returned.** Beyond
  `MAX_SALES_PRICE_POINTS` groups the request fails with a 400 asking the
  caller to narrow the window. A total that silently omits revenue is worse
  than no total.

`GET /reports/sales/orders/:orderId` takes it down to one sale: for each line
it names the price book and version that set the base price, the promotion and
version that discounted it, and then *checks* both halves of the arithmetic —
`base - discount = unit` and `unit x quantity = line total` — and the
recomputed net against the total the order header snapshotted.

## An inventory balance that equals its movements

The balance this report publishes is `SUM(quantityDelta)` over the append-only
ledger, grouped by (location, product) **in the database**. The
`InventoryLevel` projection is fetched for the same pairs and shown *beside*
it, labelled as a cross-check. It is never the answer.

When the two disagree, that difference is `projectionDriftQuantity`, and it is
reported as a platform defect.

## Drift is not variance

Phase 27 was careful about this and Phase 30 keeps it. A cycle count records
three quantities, and the two differences between them mean completely
different things:

| Figure | Definition | What it means |
| --- | --- | --- |
| **Variance** | counted - projected | Stock an operator found missing or spare. Real. Already became a signed `CORRECTION_IN`/`CORRECTION_OUT` movement. |
| **Ledger drift** | projected - ledger | The projection disagreeing with its own history. **Must be zero.** A platform bug. Corrected by nobody. |

The report sums them into two separate aggregates, counts their non-zero lines
separately, and puts them in two separate blocks — `variance` and
`projectionDefect` — with `varianceIncludesDrift: false` restated in the
payload so no consumer can add them by accident. Averaging a platform defect
into an operator's shelf count would hide both.

## Shrink is not a damaged return

`ShrinkEvent` is a CV-detected loss written off through a `SHRINK` ledger
movement. A damaged return is goods that came back and did *not* go back on the
shelf — and Phase 27 deliberately wrote **no movement** for it, because nothing
moved.

So the shrink report:

- totals `ShrinkEvent` by product and by source (`CV_DETECTED` / `OPERATOR`);
- **reconciles that against the `SHRINK` movements the ledger actually
  carries** in the same window, and says so when they disagree — a write-off
  without its movement would be a stock claim with no history;
- counts damaged returns in their own block, with
  `ledgerMovementsWritten: 0` and a sentence saying they are not shrink.

## CV accuracy without the evidence

The accuracy report is computed over `PilotObservationReview`. Reviews are
append-only, so only the newest per observation counts — a `DISTINCT ON`
selection that happens in Postgres, in this module's single raw statement
(a fixed string with bound parameters).

The metric definitions are pinned to the ones the pilot-evaluation summary
already uses, so the two surfaces can never quote different accuracies for the
same run: `decided` excludes `UNCERTAIN` and `MISSED_EVENT`; action accuracy is
`(CORRECT + WRONG_SKU) / decided` because a wrong SKU still had the right
action; SKU accuracy is `CORRECT / (CORRECT + WRONG_SKU + INCORRECT)`; and
every rate is `null` — never `0` — when its denominator is zero.

**A report over CV tables must not become a side channel for CV evidence.**
The admin CV pages carry `*-page-safety.spec.ts` guards because raw evidence
leaked into the UI before. This report honours the same boundary three ways:

1. **It projects counts only.** The raw statement selects verdicts, actions and
   catalog SKUs. No evidence bundle, vision event id, media key, storage path,
   crop artifact or reviewer note is selected, and `read-only.spec.ts` greps
   the module for every one of those identifiers.
2. **It applies the video boundary the pilot observation route applies.**
   Video-backed (`FUSION_SHADOW`) observations are included only for a caller
   holding `video-asset:read` in a tenant with the `video-ingest` module
   enabled — the same test that route makes. Otherwise the report sees live
   observations only, and says so in `scope.excluded`.
3. **It excludes `REVIEW_REQUIRED` true negatives from scoring**, exactly as
   the pilot summary does: a correct rejection is dataset evidence, not an
   accuracy judgment.

## Reporting grants nothing

Turning the module on gives a tenant no new reach.

- Every route demands `report:read` **and** the permission that already guards
  the rows it sums: `order:read`, `inventory:read`, `cycle-count:read`,
  `shrink:read`, `vision:read`. `@RequirePermissions` is AND semantics.
- Every report additionally requires its **source module** to be enabled for
  the tenant. A shrink report in a tenant that has switched `returns` off is a
  403, not an empty page.
- Every read carries `tenantId` in its own predicate — including the relation
  filters, which repeat the tenant rather than trusting the join, and the raw
  statement, which binds it as a parameter.

## Performance

Aggregation happens in the database, never in Node. Order lines are collapsed
into price points by `groupBy`; movements into signed sums per type and per
(location, product); cycle-count lines into two separate `SUM`s; reviews into
verdict counts. The only `findMany` in the module is the bounded projection
lookup for the pairs on the current balance page. A ledger is never loaded into
memory to be added up.

Nothing was cached, because nothing needed to be. If a query is ever shown to
be genuinely too slow, the honest fix is a materialised figure that says when
it was computed — which is what the `stale` flag and the page's second wording
branch already exist for.

## Where the code is

| Path | What it holds |
| --- | --- |
| `services/api/src/reporting/reporting.logic.ts` | the arithmetic — pure functions over already-aggregated rows |
| `services/api/src/reporting/reporting.repository.ts` | every database read, and nothing else |
| `services/api/src/reporting/reporting.service.ts` | the refusals: module gating, the price-point cap, the video boundary |
| `services/api/src/reporting/read-only.spec.ts` | the grep guard over the whole directory |
| `apps/admin-web/src/pages/ReportsPage.tsx` | the operator surface |
| `apps/admin-web/src/reporting-page-safety.spec.ts` | the page's own static safety pin |
