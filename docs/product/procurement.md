# Procurement

Suppliers, purchase orders and goods receipts. This is the path by which stock
legitimately enters a store, and it was the last obvious hole in the inventory
story: before this phase the ledger had exactly two writers, a manual adjustment
and a sale at checkout, so stock could only ever arrive by someone typing it in.

Platform module code: `procurement`. Every route below is tenant-scoped, gated
on that module, and behind its own permission.

## The rule everything else follows

Receiving writes the append-only inventory ledger, and nothing else.

A posted goods receipt calls `InventoryRepository.applyMovement` — the same
entry point a sale uses — once per line that actually received something, inside
the receipt's own transaction. It never writes an `InventoryLevel`. The
projection moves because the ledger moved, so a stock level and a replay of the
ledger can never disagree. A test enforces this structurally: the in-memory
harness the procurement suite runs against throws if anything in the module so
much as touches the level table.

Two consequences worth stating plainly:

- **Cancelling an order does not unwind stock.** The ledger is append-only, so a
  cancellation closes the order and leaves every movement it already produced
  standing. Correcting a mistaken receipt is a further movement, never an
  erasure.
- **Received quantity is not stored.** `PurchaseOrderLine` has no
  `receivedQuantity` column. What arrived is the sum of the `GoodsReceiptLine`
  rows pointing at the line, computed on every read. There is no counter to
  drift out of step with the receipts, and replaying the receipts always lands
  on the same answer.

## The model

| Table | What it is |
| --- | --- |
| `Supplier` | A vendor this tenant buys from. Archived, never deleted. |
| `SupplierProduct` | What one supplier calls one of our products, its pack size and its current cost. |
| `SupplierProductCost` | Append-only cost history. The newest row is what the link mirrors. |
| `PurchaseOrder` | An order placed with a supplier, delivered to one location. |
| `PurchaseOrderLine` | A product on that order: packs ordered, pack size and cost per pack, all snapshotted. |
| `GoodsReceipt` | What physically arrived, once. Append-only. |
| `GoodsReceiptLine` | One product on that delivery, and the ledger movement it produced. |

Purchase cost is deliberately separate from retail price. A `SupplierProduct`
records what we pay; a `PriceBookEntry` records what a shopper pays. Neither
derives from the other, and changing one never moves the other.

Costs are versioned the way prices are. Re-sending a supplier product with a
different cost appends a `SupplierProductCost` row rather than overwriting the
old figure, so "what were we paying in March?" has an answer.

## Lifecycle

```
DRAFT ──submit──▶ SUBMITTED ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ RECEIVED
  │                   │                        │
  └────────────── cancel ─────────────────────┘
```

Only a `DRAFT` order may be submitted, and only a `SUBMITTED` or
`PARTIALLY_RECEIVED` order may receive goods. `RECEIVED` and `CANCELLED` are
terminal. The status after a receipt is derived from every receipt that now
exists rather than nudged forward, which is why replaying the same deliveries
always produces the same status.

An over-delivered line counts as satisfied. The excess is recorded on the
receipt line as an `OVER_DELIVERY` discrepancy where an operator can see it, but
it does not leave the order forever "partially received".

## Idempotency

Posting a receipt with an `idempotencyKey` twice returns the receipt the first
call created. It does not stock the delivery again, and it writes no second
ledger movement. The guard is an advisory lock on the tenant and key pair
followed by a lookup, the same mechanism `recordExternalMovement` uses for
operator-entered stock.

Reusing a key against a *different* order is a conflict, not a silent success —
a caller must never believe a delivery was recorded when it was not.

Posting twice without a key records two deliveries, because that is what it
means: two lorries arrived.

## Discrepancies

`NONE`, `SHORT_DELIVERY`, `OVER_DELIVERY`, `DAMAGED`, `SUBSTITUTED`.

If an operator states a discrepancy, it stands. If they leave it as `NONE`, the
running totals decide between `NONE`, `SHORT_DELIVERY` and `OVER_DELIVERY` —
comparing against everything received so far, so the last of three partial
deliveries is not reported as short when it finally completes the order.

## The supplier adapter

`SupplierIntegrationPort` is the contract between BYOND and whatever actually
receives an order: an EDI gateway, a supplier portal, an ERP bridge, or a person
with an inbox. The default implementation is `SimulatedSupplierAdapter`, which
acknowledges any well-formed order without talking to anything, so the whole
lifecycle is testable with no network, no credentials and no vendor account.

Adding a real supplier means writing a new adapter class and binding it to
`SUPPLIER_INTEGRATION_PORT`. It does not mean touching the order lifecycle. No
vendor SDK type appears in domain code.

Two properties of the boundary are deliberate:

- **A rejection is a value, not an exception.** An adapter reports a failure from
  a closed vocabulary, so an operator sees "the supplier was unreachable" rather
  than a provider's error string, which could carry a URL or a credential into
  our logs and audit trail.
- **The adapter runs before anything is written.** An outbound call never holds a
  database transaction open, and a rejected order stays in `DRAFT` where it can
  be corrected and resent.

## Endpoints

| Method and path | Permission |
| --- | --- |
| `GET /suppliers`, `GET /suppliers/:id` | `supplier:read` |
| `POST /suppliers`, `PATCH /suppliers/:id` | `supplier:manage` |
| `PUT /suppliers/:id/products` | `supplier:manage` |
| `GET /supplier-products` | `supplier:read` |
| `GET /purchase-orders`, `GET /purchase-orders/:id` | `purchase-order:read` |
| `POST /purchase-orders` | `purchase-order:manage` |
| `POST /purchase-orders/:id/submit` | `purchase-order:manage` |
| `POST /purchase-orders/:id/cancel` | `purchase-order:manage` |
| `POST /purchase-orders/:id/receipts` | `goods-receipt:manage` |
| `GET /goods-receipts` | `goods-receipt:read` |
| `GET /goods-receipts/:id/movements` | `goods-receipt:read` |

Receiving has its own permission on purpose. Raising an order commits money;
receiving moves stock. Those are different jobs and, in most stores, different
people.

## Safety

Contact details, notes, cancellation reasons and discrepancy notes are free text
that is copied into the audit log, which outlives ordinary retention. Every one
of them is screened for credential- and payment-shaped values before it is
stored, and a match is rejected with a 400.

Supplier connection credentials are never stored on a `Supplier` row. An adapter
reads them from configuration.

Cross-tenant stitching is impossible by construction rather than by care: every
foreign key in this domain has a composite `(id, tenantId)` twin in the
migration SQL, including the one from a receipt line to the ledger movement it
produced.

## Known limitations

- **No returns to supplier.** Sending stock back is a different movement and
  arrives with the returns and refunds phase.
- **No partial-line receipt splitting.** A line appears at most once per receipt;
  two deliveries of the same line are two receipts.
- **No landed cost.** Freight, duty and handling are not apportioned onto unit
  cost. `unitCostMinor` is what the supplier invoices per pack.
- **No automatic reordering.** Low stock does not raise a draft order. The
  supplier lead time is recorded but only used to suggest a delivery date.
- **One currency per order.** Mixed-currency orders are not supported, in the
  same way a price book is currency-homogeneous.
- **No receipt without an order.** Everything received is received against a
  purchase order line. Unexpected stock is still a manual adjustment.
