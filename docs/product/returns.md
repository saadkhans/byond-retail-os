# Returns, refunds and inventory reconciliation — the reverse flow

Every phase before this one moved goods and money in one direction: stock came
in, a shopper took it, an order was created, a payment was captured. Phase 27
builds the other direction — and does it without loosening a single rule that
made the forward direction trustworthy.

There are four paths. All four end in the same place.

| Path | What happens | Ledger movement |
| --- | --- | --- |
| Customer return | Named order lines come back; the money they were worth is refunded | `RETURN_IN` (positive) |
| Order cancellation | Everything still outstanding comes back and the order is cancelled | `RETURN_IN` (positive) |
| Cycle count / stocktake | A counted quantity is compared with the books; the difference is corrected | `CORRECTION_IN` / `CORRECTION_OUT` (signed) |
| Shrink | A CV-detected loss no order accounts for is written off | `SHRINK` (negative) |

## The rule that shapes everything here

> **Stock changes ONLY through the append-only ledger.**

A return is not "add the units back". A cancellation is not "undo the sale". A
stocktake is emphatically not "set stock to what I counted". Each of them is a
**movement**: a signed delta, appended to `InventoryMovement`, through the same
`InventoryRepository.applyMovement` that checkout completion uses to take stock
away. The `InventoryLevel` projection moves because the movement moved it, and
for no other reason.

Nothing in `services/api/src/returns/` writes an `InventoryLevel`. That is not
a convention — it is enforced three times over:

1. **A grep guard** (`returns/boundary.spec.ts`) fails the build if any file in
   the module calls a write method on `inventoryLevel` or `inventoryMovement`,
   and separately asserts that all three stock-touching repositories *do* call
   `applyMovement`.
2. **Structural booby-traps** in the repository tests: `tx.inventoryLevel` is a
   `Proxy` that throws on property access, so a test cannot pass by accident if
   the projection is touched. (The cycle-count harness allows exactly
   `findFirst` — reading the projection is the whole point of reconciling it.)
3. **Database CHECK constraints**: a return line that claims `restocked` must
   carry a `movementId`; a cycle-count line with a non-zero variance must carry
   one; and `ShrinkEvent.movementId` is `NOT NULL`. There is no way to *store*
   a stock claim without the ledger row behind it.

## Refunds

Refunds go through the existing provider-neutral payment abstraction. This
module owns no payment logic and touches no payment table; it calls
`PaymentsService.refund`, which is the same path an operator drives by hand
through `POST /payments/intents/:id/refund`.

Two properties matter more than anything else:

**Bounded.** A refund is legal only against a `CAPTURED` intent, and the sum of
`PENDING` + `SUCCEEDED` refunds on an intent can never exceed its
`capturedAmountMinor`. In-flight money counts against the ceiling, so a second
request cannot spend it twice. The ceiling is computed under the per-intent
advisory lock from the refund rows themselves (never from a denormalised
total), and a CHECK constraint on `PaymentIntent` backstops it in the database.

**Idempotent.** `(tenantId, idempotencyKey)` is unique on `PaymentRefund`, and
a return derives its refund key from the return id — which is itself guarded by
the caller's tenant-scoped `reference`. A replayed return request therefore
reaches the same refund row and pays nobody twice.

The refund is a **two-step** operation, deliberately:

1. `openRefund` records a `PENDING` refund inside a transaction and projects the
   order to `REFUND_PENDING`.
2. The owned **refund-gateway port** is called *outside* any transaction, so a
   slow or hanging provider cannot hold database locks open.
3. `settleRefund` records the answer exactly once, through a conditional
   tenant-scoped write that matches only a `PENDING` row.

If the process dies mid-flight, the refund is still there, `PENDING`, and the
order says so. Replaying the request picks it back up. Nothing is lost and
nothing is paid twice.

The only implementation of the port is `SimulatedRefundGateway`. There is still
no live gateway, no provider SDK and no card data anywhere: the request carries
an opaque refund id, a provider name, an amount and a currency. A real adapter
looks the instrument up on its own side.

### Terminal payment states

`CAPTURED` is a terminal payment status — and it is the **only** terminal status
a refund is legal from, precisely because it is the one that means money was
taken. Every other terminal state (`CANCELLED`, `FAILED`, `VOIDED`, `EXPIRED`)
means no money ever moved, so there is nothing to give back. The refund path
therefore does not use the generic terminal guard; it checks for `CAPTURED`
explicitly.

The same fact resolves a thread Phase 26 left open. Store-flow settlement used
to drive `authorize` → `capture` on whatever intent an order already had, which
threw if that intent was terminal. It now recognises the case and stops, with a
`PAYMENT_TERMINAL` block reason: the order stands, created and payable by hand.
Re-authorising is illegal, and silently minting a second intent would take money
for an attempt somebody deliberately cancelled — retrying payment is a decision,
not a side effect of walking out of a shop. On the returns side the same order
has no captured intent, so a return records `NO_CAPTURED_PAYMENT` and reverses
the goods anyway. Both halves agree.

## Returns and cancellations

`POST /returns` records both kinds.

- A **customer return** names the order lines coming back. Each line may be
  marked as not restocked (damaged, unsellable), in which case no movement is
  written — the honest record that stock did not change. The money is
  independent: damaged goods can still be refunded.
- An **order cancellation** takes back everything still outstanding and flips
  the order to `CANCELLED`. This is the path a **paid** order is cancelled
  through; `POST /orders/:id/cancel` still refuses one, and now says where to go.

Ceilings are per order line and cumulative: "ordered minus already returned",
counted across every earlier return. Two entries for the same line in one
request are rejected outright, because each would pass the ceiling check alone
while together exceeding it.

Value is **all or nothing**. A return is worth something only when every line it
carries is priced, in one currency, and the total fits the column — the same
rule checkout uses when it refuses to total a basket with an unpriced line.
Otherwise the return records `NO_PRICEABLE_LINES` and no money moves.

**Goods first, money second.** The stock reversal and the return record commit
together; only then is a refund attempted. A failed refund leaves a correct,
visible record with the goods properly back on the shelf. The reverse order
would be unrecoverable: money moved for goods that never came back.

## Cycle counts and stocktakes

An operator opens a count for a store, records what they find product by
product, then reconciles. Opening changes nothing. Counting changes nothing.
Only reconciling writes anything, and then only the difference.

For every counted product, under that product's advisory lock, reconciliation
reads three numbers:

| Number | Where it comes from |
| --- | --- |
| `countedQuantity` | What the human found on the shelf |
| `systemQuantity` | The `InventoryLevel` projection, read (never written) |
| `ledgerQuantity` | The `InventoryMovement` ledger, replayed by summing deltas |

`varianceQuantity` = counted − projection. That is what becomes a signed
`CORRECTION_IN` / `CORRECTION_OUT` movement. A count that agrees with the books
writes **nothing at all** — a stocktake must not pollute the ledger with no-op
rows.

`ledgerDriftQuantity` = projection − ledger replay. It must always be zero. A
non-zero value means the projection disagrees with its own history: a platform
bug, not a stock discrepancy. It is **recorded and surfaced**, never folded into
the operator's variance and quietly "corrected". The admin page says so in
those words.

This is what keeps reconciliation from becoming a second source of truth. The
counted figure is never assigned anywhere — a database CHECK even requires the
stored variance to equal `countedQuantity - systemQuantity`, so it cannot be an
arbitrary number.

## Shrink

`POST /shrink-events` turns one CV-detected loss into one `SHRINK` movement plus
the record of who decided and why. Nothing watches the observation stream and no
pipeline output reaches this route: a write-off removes real stock, so it stays
a human decision.

The gates exist so that it cannot become a way to make stock disappear:

- the observation must exist **in this tenant** and be a `PRODUCT_PICKUP`;
- it must not still be queued for review — an undecided observation is not yet
  a loss;
- the product must be one the observation actually **proposed**, so a write-off
  cannot name an unrelated SKU;
- the quantity cannot exceed what was observed;
- no live order may already account for the goods. If the shopper's session
  became an order that was not cancelled, they paid, and this is not shrink.

`(tenantId, visionEventId)` is unique, so one observation can be written off
exactly once. A replay asking for a different product or quantity is a conflict,
never a silent success.

The movement cites the **observation** as its cause (`referenceType:
'VisionEvent'`), because the observation is the evidence and already exists when
the movement is appended — no back-patching.

## Tenancy, locks and free text

**Every destructive write carries the tenant in its own predicate**, through the
`id_tenantId` composite key or a tenant-leading composite key — never relying on
a prior tenant-scoped lookup. A grep guard in `boundary.spec.ts` enforces it
across the whole module, and same-tenant composite foreign keys in the migration
make a cross-tenant reference impossible even if the application layer were
bypassed.

**Lock order** is `order-return → order-payment → product` for returns,
`cycle-count → product` for counts, and a dedicated `shrink-event` key for
write-offs. Multi-product paths visit products in id order, exactly like
checkout completion, so concurrent reverse-flow writes sharing products cannot
deadlock.

**Every operator free-text field** — return reason, condition note, count
discrepancy note, shrink justification, and the `reference` itself — is screened
with the strict `containsSensitiveFreeText` predicate *before* any write. These
strings are persisted verbatim into append-only records **and** copied into
`AuditLog.reason`, which audit redaction does not cover, so a pasted PAN would
sit there forever. Rejection is a controlled 400; redaction is only ever a
backstop.

## Permissions

| Permission | What it allows |
| --- | --- |
| `return:read` | View returns, the stock they reversed, the refunds they triggered |
| `return:manage` | Record a return or cancel a settled order |
| `cycle-count:read` | View counts with counted / projected / ledger / variance |
| `cycle-count:manage` | Open, count, reconcile, abandon |
| `shrink:read` | View recorded write-offs |
| `shrink:record` | Write off a CV-detected loss |
| `payment:refund` | Refund money against a captured payment |

`shrink:record` is a permission of its own precisely because it removes real
stock from the books, and `payment:refund` is separate from `payment:simulate`
for the same reason on the money side.
