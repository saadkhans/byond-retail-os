# Pricing

AGENTS.md states the rule this phase implements: *pricing changes must be
versioned, auditable, and reversible*. Phase 25 makes that structural rather
than procedural. A price is never a mutable column on a product. It lives in an
immutable entry inside a version of a price book, and the only way to change it
is to create a new version.

## The model

**Price book.** A named, currency-homogeneous set of prices, unique by code
within a tenant. A book is either tenant-wide or scoped to one store. Its code,
currency and scope are identity and never change, because changing them would
silently reinterpret every version in its history. Only the display name and
the archived flag are editable.

**Price book version.** One revision of a book, numbered monotonically from 1.
A version is `DRAFT` while it is being prepared, `ACTIVE` once it applies,
`SUPERSEDED` once a newer version replaces it, and `ARCHIVED` if it is
withdrawn without ever having applied. Each version carries a half-open
effective window, a closed-vocabulary reason, and an optional note.

**Price book entry.** One product's price inside one version, in minor currency
units as an integer. There is no floating point anywhere in the money path.

## Invariants

- **Entries are frozen once their version leaves `DRAFT`.** Superseded versions
  still answer historical price questions, and an order that cited one has to
  stay explicable. Changing a price means a new version.
- **A book has at most one `ACTIVE` version.** Enforced by a partial unique
  index in migration SQL, so even two racing activations cannot leave a book
  with two current versions.
- **Activation closes the previous window rather than deleting it.** The old row
  keeps its prices, gains an `effectiveTo` equal to the new version's start, and
  points at its successor.
- **Rollback appends.** Rolling back to version 2 copies version 2's entries
  into a new version 4 and activates that. Version 2 is never resurrected or
  edited, so the audit trail reads forward: v3 was wrong, v4 restored v2.
- **A version with no entries cannot be activated.** It would silently unprice
  the whole book.
- **Effective windows only move forward.** Activating with an `effectiveFrom` at
  or before the current version's start is rejected, because the two windows
  would otherwise invert.
- **Every mutation is audited** with who, when and why. Activation is recorded
  as `PRICE_CHANGE` and a rollback as `ROLLBACK`, because those are the moments
  money actually changes; creating a book or editing a draft is an ordinary
  create or update.
- **Every query is tenant-scoped at the repository layer,** like all tenant data.

## Resolving a price

`GET /prices/resolve?productId=&at=&locationId=` answers "what does this cost?"
at an instant, defaulting to now.

The rule, in order:

1. Only versions whose half-open window `[effectiveFrom, effectiveTo)` contains
   the instant are eligible. `SUPERSEDED` versions stay eligible, which is what
   makes a historical lookup return what the product actually cost then rather
   than what it costs today. Drafts and archived versions never resolve.
2. Only books that apply at the given location are eligible: the tenant-wide
   book always, a store-scoped book only at its own store.
3. The most specific book wins, so a store book overrides the tenant-wide one.
4. Remaining ties break deterministically, by later start, then higher version
   number, then book code. Determinism matters more than the choice: the same
   basket must never price differently on a retry.

Nothing applying returns null. Callers treat that as **unpriced**, never as
free.

The decision itself lives in `services/api/src/pricing/pricing.logic.ts` as a
pure function, so the rule that determines what a shopper is charged is
unit-testable without a database.

## How money reaches a basket and an order

When a basket line is added, checkout resolves the price inside the same
transaction and under the same product lock that creates the line, then
**snapshots** it onto the line. Changing the quantity re-multiplies that
snapshot; it never re-resolves. Re-pricing an open basket because a new version
activated mid-shop is exactly what the snapshot prevents.

On completion, the order's subtotal and total are derived from those snapshots.
This is all-or-nothing: a basket with any unpriced line, or with lines in more
than one currency, completes with null totals rather than a total that quietly
omits lines. Order lines copy the price they were charged at, so the chain from
session to basket line to order line to payment stays explicable.

`totalMinor` equals `subtotalMinor` today. Tax, discounts and promotions are
later phases; keeping the fields distinct now means adding them will not change
the shape of an order.

Finally, a priced order becomes the authority on what may be charged: creating a
payment intent against an order that states a total rejects any other amount or
currency. An order with no total keeps the previous behaviour, where the caller
supplies the amount.

## Backwards compatibility

Pricing is additive. A tenant with the module disabled, or with no price books,
sees exactly the pre-Phase-25 behaviour: lines carry no price, orders carry no
total, and payment amounts are caller-supplied. The resolver is injected into
checkout as an optional port, so even a deployment assembled without the pricing
module keeps a working basket.

## Endpoints

All are tenant-scoped and gated on the `pricing` module.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/price-books` | `price-book:read` |
| POST | `/price-books` | `price-book:manage` |
| GET | `/price-books/:id` | `price-book:read` |
| PATCH | `/price-books/:id` | `price-book:manage` |
| POST | `/price-books/:id/versions` | `price-book:manage` |
| GET | `/price-books/:id/versions/:versionId` | `price-book:read` |
| GET | `/price-books/:id/versions/:versionId/entries` | `price-book:read` |
| PUT | `/price-books/:id/versions/:versionId/entries` | `price-book:manage` |
| POST | `/price-books/:id/versions/:versionId/activate` | `price-book:manage` |
| POST | `/price-books/:id/versions/:versionId/rollback` | `price-book:manage` |
| GET | `/prices/resolve` | `price:read` |

## Known limitations

- **No tax, discounts or promotions.** `totalMinor` equals `subtotalMinor`.
  Promotions arrive with the loyalty phase and will participate in resolution
  rather than bypassing versioning.
- **No customer- or channel-specific books.** Scope is tenant-wide or per store.
- **No scheduled-activation worker.** A future `effectiveFrom` is accepted and
  resolves correctly from the moment it arrives, but activation itself is an
  explicit operator action; nothing activates a draft on a timer.
- **No price import or export.** Entries are set through the API or the admin
  page one book at a time.
- **No electronic shelf label propagation.** Activating a version changes what
  checkout charges; pushing it to a label is the ESL phase.
