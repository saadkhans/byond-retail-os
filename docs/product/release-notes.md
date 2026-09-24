# Release notes

This release takes BYOND from a computer-vision prototype with a tenant API
behind it to a retail operating system with a commercial half: prices, a store
loop a shopper can walk through, money that can go backwards as well as
forwards, labels on the shelf, loyalty, purchasing, reporting, an in-store
runtime that survives the cloud going away, and a phone app for the shopper.

Everything below is written in plain language. The design rules behind it are in
[ARCHITECTURE.md](../../ARCHITECTURE.md); what is **not** proven is in
[release-pr.md](release-pr.md), and that section is the one to read before
deploying anything.

One rule holds across every item: **nothing here mutates a figure in place.**
Prices are versions, stock is a ledger, points are a ledger, promotions are
versions, reports are derived on read. If a number changed, you can find out
when, who did it, and what it was before.

---

## Pricing (Phase 25)

Prices stop being a field on a product and become rows in a *version* of a price
book.

- Publish a draft, set entries, activate it. The previous version keeps its
  numbers and its date range, so the price a shopper paid last March can still
  be looked up.
- Rollback copies an earlier version forward as a new version. History reads
  forward and is never rewritten.
- Books can be tenant-wide or store-specific; the store's own book wins at that
  store.
- A basket line locks its price the moment it is added, so activating a new
  version mid-shop cannot re-price a basket someone is already carrying.
- A priced order becomes the authority on what may be charged: a payment for a
  different amount or currency is refused.
- A retailer with no price books sees exactly the old behaviour — no prices, no
  order totals.

Not included: tax (anywhere in the platform), customer- or channel-specific
books, scheduled activation on a timer, and price import/export.

## The store loop (Phase 26)

The loop closes. A shopper enters, cameras watch, the basket fills, they leave,
and an order and a payment come out the other end.

- An operator issues a single-use entry code — two minutes by default, fifteen
  at most — which opens a shopper, a journey and a basket bound together.
- How much the store may do unattended is a **versioned, audited setting** per
  tenant or per store: observe only, propose for approval, or apply
  automatically above a confidence floor.
- **The default is observe-only.** Turning the module on changes nothing until a
  retailer opts in. This is deliberate and is enforced structurally, not by
  convention.
- One review queue shows every uncertain pickup and what the system did with it.
  A journey with anything still awaiting review will not settle.
- Repeats are safe throughout: re-running entry, sync, exit or payment re-reads
  what already happened instead of double-charging or double-consuming stock.

Not included: a real payment gateway (the provider vocabulary is still simulated
and manual), and a confidence floor that means a probability rather than a
ranking score tuned on your own footage.

## Returns, refunds and reconciliation (Phase 27)

Money and goods can now go backwards.

- Four ways stock comes back: a customer return, cancelling a settled order, a
  stocktake correction, and a write-off for loss the cameras saw.
- Refunds are capped at what was actually captured, cannot be paid twice on a
  retry, and survive a crash mid-flight as a visible pending refund rather than
  a lost one.
- Damaged goods can be refunded without going back on the shelf, and the record
  honestly says stock did not change.
- Cycle counts show three figures side by side: what was counted, what the
  system thought, and what a full ledger replay says. Only the difference is
  written; a count that agrees writes nothing at all.
- If the system's figure and the ledger replay disagree, that is reported as a
  **platform defect**, never quietly folded into the operator's variance.
- Writing off a loss stays a human decision with its own permission, is limited
  to what was actually observed, and can happen only once per observation.

Not included: a real refund gateway, and returns to a supplier.

## Electronic shelf labels (Phase 28)

Labels become a managed part of the platform, without tying the platform to a
vendor.

- Register the in-store gateway, discover or add its labels, bind each to a
  product.
- Activating (or rolling back) a price version automatically queues a push to
  every bound label showing that product.
- Adding a real vendor is one adapter class. No route, schema or workflow
  changes. The only adapter shipped is simulated, so the whole propagation path
  runs in CI with no hardware, network or vendor account.
- **A label that cannot be reached never blocks a price change.** The price is in
  force the moment the activation commits; a reconcile pass compares every label
  against the price actually in force and repairs the difference.
- A push always carries the price in force at push time, so a label ends up
  showing the truth even if the price moved again in between.
- Reading label health is a separate permission from rebinding hardware or
  driving the queue.

Not included: any real vendor driver, and a background worker — the queue is
drained by an explicit operator action.

## Loyalty and promotions (Phase 29)

Discounts arrive without touching pricing.

- The price book resolves first and unchanged; the promotion is a separate,
  recorded layer applied on top. The price book stays the single explanation of
  base price.
- Promotions get the lifecycle operators already know from price books: draft,
  activate, supersede, roll forward, roll back.
- Everyone or members only; whole-catalogue or per product; tenant-wide or
  store-scoped; percent off, amount off, or a fixed unit price.
- Loyalty accounts have a points ledger. The balance is always the sum of its
  movements, can never go negative, and cannot be double-spent on a retry.
- One request explains any price to any shopper: base price, which price version
  set it, which promotion version discounted it, what they pay. Both ids are
  stamped onto the basket line and the order line, so an order placed today
  still explains itself years from now.
- Shelf labels are deliberately untouched by loyalty. A shelf-visible
  promotional price is made as a price book version.

Not included: stacking. Exactly one promotion applies — the largest discount.
This was refused on purpose: two discounts composing produce a price no single
rule explains, and the result is unbounded below without a separate floor rule.

## Reporting (Phase 30)

Seven reports for operators: sales, one sale explained line by line, inventory
movements, inventory balances, count reconciliation, shrink, and CV accuracy.

- **Every figure is computed live from the source records at the moment it is
  asked for.** No roll-up tables, no caches, no nightly jobs — and no database
  model of its own. Reporting structurally cannot become a second set of books.
- Every response says when it was generated and which tables it came from.
- Sales break down by price point and name the price version and promotion
  version behind every figure, and the report states whether gross minus
  discount reconciles to net.
- Currencies are never added together. A breakdown too large to return fails
  with a clear "narrow the window" rather than quietly omitting revenue.
- Inventory balances are the sum of the ledger, with the stored stock level
  shown beside them purely as a cross-check. Any disagreement is reported as a
  platform defect.
- Stocktake variance (real, operator-found) and ledger drift (a bug) are kept in
  separate blocks so they can never be averaged together.
- CV accuracy reports **counts only** — no evidence, clips, crops or reviewer
  notes — and honours the same video-access boundary as the CV pages.
- Turning reporting on grants no new reach: each report needs the reporting
  permission **and** the permission that already guards the underlying rows,
  **and** the source module enabled.

## Procurement (Phase 31)

Stock can finally arrive legitimately, instead of someone typing an adjustment.

- Suppliers, purchase orders and goods receipts.
- Supplier catalogue links record what the supplier calls each product, its pack
  size and its cost, with append-only cost history — so "what were we paying in
  March?" has an answer.
- Purchase cost and retail price are kept deliberately separate. Changing one
  never moves the other.
- A purchase order's status is always *derived* from the receipts that exist, so
  replaying deliveries lands on the same answer.
- Receiving writes the same append-only inventory ledger a sale does, so stock
  levels and ledger history can never disagree.
- Posting a receipt twice with the same key returns the first receipt and does
  not re-stock the delivery. The same key against a different order is a
  conflict, not a silent success.
- Short, over, damaged and substituted deliveries are all recorded; an
  over-delivery closes the line rather than leaving the order stuck open.
- Raising an order and receiving goods are separate permissions, because in most
  stores they are different people.

Not included: returns to supplier, partial-line receipt splitting, landed cost
(freight/duty/handling are not apportioned), automatic reordering,
mixed-currency orders, and receiving anything that has no purchase order.

## Shared packages (Phase 32)

The workspace grew three real packages instead of duplicated code: `shared`
(types and utilities, 87 tests), `config` (lint/TS/build configuration used by
every package) and `ui` (shared components). Nothing user-facing changed; what
changed is that the next feature has one place to put a shared type.

## Edge runtime (Phase 33)

The edge-first principle stops being aspirational. `services/edge-runtime` is a
real service that keeps a store trading when the cloud link is down.

- **No database.** Durable state is a directory of files: replaceable *records*
  the cloud pushes down (catalog, planogram, prices, units, devices) and
  append-only *logs* of facts (the local ledger, outbox, inbox, conflicts, dead
  letters, CV proposals as observed).
- Stock on the edge moves only through the local append-only ledger, exactly as
  in the cloud, so a silent overwrite is structurally impossible on the box too.
- A box is sealed on first use to one retailer, one location and one device, and
  refuses to start against a directory belonging to anyone else. The refusal
  names the fields that differ and never their values, so a misconfigured node
  cannot leak another tenant's identifiers through its own logs.
- Clear ownership: the cloud owns configuration coming down, the store owns
  facts it observed going up, and anything else is recorded as a conflict rather
  than guessed at. Configuration can never write a ledger fact.
- Facts are delivered at-least-once, in order, with stable idempotency keys, so
  a crash and replay never records a fact twice — and a locally-observed fact is
  never silently dropped.
- Cameras only propose; the local ledger validates; anything unconfident,
  unknown or unsupported goes to a local review queue an operator can clear
  **while still offline**.
- Cameras, scales, shelf labels, gates and POS peripherals all sit behind ports
  this repository owns, each with a simulated driver, so the whole suite runs
  with no hardware. A failing device degrades rather than stopping the store.
- The control-plane URL must be https (loopback http in dev/test only),
  embedded credentials are rejected, and a URL with no token fails fast. Health
  and metrics bind to loopback unless deliberately widened.

Not included: local checkout and local ESL updates. The extension points exist
and are marked in the code, but those loops still run in the cloud. See the
corrected claim in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## CV pipeline (Phase 34)

`services/cv-pipeline` became a real tier-1/tier-2 service behind swappable
ports: continuous lightweight tracking on a downscaled stream, a trigger layer
that decides which moments are worth a heavy model, and an inference job per
triggered moment. Product identity stays in the API — the pipeline proposes
moments, never SKUs. The defaults need no camera, no ffmpeg and no model
weights.

## The shopper application (Phase 35)

The shopper gets their own app and their own credential.

- Four screens — entry, live basket, exit, payment result — opened from a QR
  code at the door. It is a mobile-first web app, because this repository has no
  native mobile toolchain; a native shell can wrap the same four screens later
  without changing the contract.
- Entry is by the single-use door code the store already issues. That same
  secret then proves who the shopper is for up to four hours, long enough for
  any visit.
- **The app never names a tenant, store, journey or shopper.** Every identifier
  is read off the credential server-side, so there is no parameter a shopper
  could tamper with to reach anyone else's data.
- The basket screen tells the truth about the store's autonomy setting: in
  observe-only mode it says plainly that items are not being added
  automatically and a colleague will check them out.
- "Checking with a colleague" is shown as a normal state, not an error, when
  something is still awaiting review at exit, with a check-again action.
- **No payment form, field or handler exists anywhere in the app.** A payment
  that did not go through tells the shopper to pay at the counter rather than
  offering a retry button.
- A failed exit or a lost connection returns the shopper to an intact basket,
  because retrying exit is safe.
- The app writes nothing of its own: every effect runs through the same
  store-flow service an operator drives by hand.

This is the repository's **first public API surface** — three routes reachable
without a staff login. See the risk section in [release-pr.md](release-pr.md).

## Infrastructure and security hardening (Phase 36)

Real security scanning, container builds and reusable CI blocks under `infra/`
and `.github/`, replacing placeholder jobs. See
[docs/development/ci-and-security.md](../development/ci-and-security.md).

## Tenant write-predicate hardening (cross-cutting)

A repo-wide sweep changed every destructive database write — delete, update and
their bulk forms — so the tenant is named inside the write's own predicate
rather than relied upon from a lookup that happened a statement earlier. A guard
walks the whole API source tree to keep it that way, with an allowlist whose
every entry has to explain itself.

Read the honest limit of this guard in [release-pr.md](release-pr.md): it is a
textual check, and textual checks prove less than they appear to.

## Documentation (Phase 37)

This release note, the release pull request, and a correction pass over
`README.md`, `ARCHITECTURE.md`, `TESTING.md`, `services/api/README.md`, the
Swagger description, and the "known limitations" sections of the pricing,
store-flow, loyalty and procurement product docs — several of which promised
work that had since shipped, or described a system two dozen phases old.
