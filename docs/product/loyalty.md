# Loyalty and promotions

Phase 25 made pricing versioned, auditable and reversible. Phase 28 made price
*activation* the event that drives shelf labels. Phase 29 adds discounts — and
the only interesting question about a discount is how it can exist at all
without undoing either of those.

The answer this phase implements: **a promotion is not a price. It composes on
top of one.**

```
paid = resolvePrice(product, at, location)     <- pricing, unchanged
       - selectPromotion(product, at, location, member)   <- loyalty, on top
```

Pricing runs first and alone. It picks the price book version in force and
returns an immutable answer. Only then is the promotion layer asked whether
anything reduces it. There is no code path from a promotion to a price row —
only from a price *value* to a smaller price *value*.

## Why not participate inside price resolution?

The tempting design is to let promotions join the candidate set inside
`selectPrice()`, competing with price book versions on specificity. It was
rejected, for three reasons:

1. **Explainability collapses.** If a promotion can win the resolution, the
   resolved price names a "winner" that may or may not be a price version. A
   price a shopper paid must always name a price version — that is what makes
   price history worth keeping.
2. **Immutability gets blurry.** Anything inside resolution eventually wants to
   write to the thing it resolves: supersede a version, adjust a window, mark a
   row. Keeping promotions structurally outside means they have nothing to
   write to.
3. **Shelf labels stop being coherent.** ESL renders the price in force. If a
   member-only discount were a price, the label would have to show a price that
   is true for some shoppers and false for others.

So promotions resolve **on top of** an activated price version, not inside the
resolution that chooses it. Both halves are recorded, so nothing is lost.

## What a shelf label shows

Unchanged: the price in force, from the price book version in force. A loyalty
promotion is a basket-time adjustment and does **not** change the shelf.

An operator who wants a discount *on the shelf* expresses it the way Phase 25
already provides for: a **price book version with reason `PROMOTION_BASE`**.
That is a real price change — versioned, activated, propagated to labels,
rollback-able. The enum value has been in the schema since Phase 25; this phase
is where it earns its keep.

The two mechanisms are deliberately different tools:

| | Shelf-visible promotional price | Loyalty promotion |
|---|---|---|
| Modelled as | `PriceBookVersion`, reason `PROMOTION_BASE` | `PromotionVersion` |
| Changes the label | Yes | No |
| Can be member-only | No | Yes |
| Recorded on the line as | `priceBookVersionId` | `promotionVersionId` |

## The model

**LoyaltyAccount.** Tenant-scoped, identified by an operator-issued
`memberCode`. `ACTIVE` → `SUSPENDED` (reversible) or `CLOSED` (terminal). The
member code is an identifier, never a contact detail; `displayName` is screened
free text.

**LoyaltyPointMovement.** One append to an account's ledger. Signed `points`, a
`sequenceNumber` monotonic per account, and a `balanceAfter` stamp. **A balance
is never a column.** It is `SUM(points)`, and the ledger is append-only at the
database level — a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`, exactly
as for `InventoryMovement` and `AuditLog`. A mistake is corrected by appending
a `REVERSAL`.

**Promotion.** A named discount programme, tenant-unique code, an `audience`
(`ALL_SHOPPERS` / `LOYALTY_MEMBERS`), an optional location scope, and a
`priority` used only to break ties.

**PromotionVersion.** One immutable revision. `DRAFT` → `ACTIVE` →
`SUPERSEDED`, with half-open `[effectiveFrom, effectiveTo)` windows — the same
lifecycle a price book version has, deliberately, so an operator who
understands one understands the other. Rollback copies an old version forward
rather than reopening it.

**PromotionRule.** One effect inside one version: `PERCENT_OFF` (basis points),
`AMOUNT_OFF` (minor units), or `FIXED_UNIT_PRICE` (minor units). `productId`
null means the whole catalog; a product-specific rule beats the catalog-wide
one.

## Composition rules

`services/api/src/loyalty/loyalty.logic.ts` decides, purely:

1. Only versions whose half-open window contains `at`. `SUPERSEDED` versions
   stay eligible, so a historical quote reproduces exactly.
2. Only promotions that apply at the location — tenant-wide always, a
   location-scoped one only at its own location.
3. `LOYALTY_MEMBERS` promotions need an **ACTIVE** account on the basket.
4. The version must have a rule for this product that actually takes something
   off. A promotion that discounts nothing is not applied, so a line never
   names a promotion that did not change its price.
5. **Promotions do not stack.** Exactly one applies: the largest discount.
   Stacking was refused deliberately — two discounts composing produce a price
   no single rule explains, and the result is unbounded below without a
   separate floor rule. An operator who wants a combined effect writes one
   rule.
6. Ties break deterministically: priority, then location specificity, then
   later `effectiveFrom`, then version number, then code. The same basket must
   never price differently on a retry.

Every path is integer-exact on minor units; `PERCENT_OFF` floors the
*discount*, so the rounding direction is stated rather than emergent.

## Points

- **Accrual and redemption are the same operation** with opposite signs, so
  there is one code path, one lock, and one set of guarantees.
- **A redemption can never overdraw.** The floor is enforced three ways: a
  per-account advisory lock serializes appends; a
  `CHECK ("balanceAfter" >= 0)` sits on the row being inserted; and a unique
  `(accountId, sequenceNumber)` index makes a lost update impossible. The
  application also projects the append and rejects an overdraw as a clean 409 —
  but that is a courtesy, not the guarantee.
- **Every movement is idempotent** on a tenant-scoped `idempotencyKey`. A
  retried redemption returns the *original* movement. On an append-only ledger
  a double-spend is unrecoverable, so the key is required, not optional.
- A key already used by a *different* account is a 409, never the other
  account's movement.

## Explainability

`GET /loyalty/quote` answers "what does this cost this shopper, and why":

```json
{
  "productId": "...",
  "basePriceMinor": 1000,
  "priceBookVersionId": "ver-7",
  "promotion": { "promotionVersionId": "pver-3", "discountMinor": 150, ... },
  "unitPriceMinor": 850,
  "currencyCode": "AED"
}
```

The same two ids are written onto the basket line and copied to the order line
at completion (`priceBookVersionId`, `basePriceMinor`, `promotionVersionId`,
`promotionDiscountMinor`), so an order placed today still names its price
version and its promotion version years later — after both have been
superseded.

Database `CHECK` constraints make that structural: on both
`CheckoutSessionLine` and `OrderLine`, a promotion discount must be in
`[0, basePriceMinor]`, `unitPriceMinor` must equal `basePriceMinor -
promotionDiscountMinor`, and a `promotionVersionId` without a
`priceBookVersionId` is rejected. A promotion that tried to *raise* a price —
the closest thing composition could produce to bypassing price versioning — is
a failed write.

## Invariants

- **A promotion never writes a price row.** Pinned by
  `promotion-price-immutability.spec.ts`, which drives the whole promotion
  lifecycle against a Prisma stand-in whose `priceBook`, `priceBookVersion` and
  `priceBookEntry` models are `Proxy` objects that throw on *any* property
  access — not on `.update()`, on `.update` itself. A static grep guard in the
  same file covers every line in the directory, including paths no test drives.
- **Price history is append-only.** Nothing in this phase's migration alters,
  drops, or writes a price table. The only permitted mention of
  `PriceBookVersion` is as a foreign-key target.
- **Points are append-only.** Database trigger, not convention.
- **Tenant isolation at the data layer.** Every destructive write carries the
  tenant in the write predicate through the `id_tenantId` composite key
  (`loyalty.repository.spec.ts`), and every cross-table reference has a
  same-tenant composite FK in migration SQL.
- **No payment data in free text.** Promotion names, account labels, points
  notes and reason codes are screened with `containsSensitiveFreeText` before
  they are persisted or copied into `AuditLog.reason`.
- **Stock still moves only through the inventory ledger.** This phase does not
  touch it.

## Wiring

Checkout takes **two** optional ports, not one:

- `LINE_PRICING_PORT` (Phase 25, implemented by pricing) — what does this cost?
- `LINE_PROMOTION_PORT` (Phase 29, implemented by loyalty) — does a promotion
  reduce it?

Both are `@Optional()`. A deployment without loyalty, or a tenant with the
module disabled, gets the exact Phase 28 basket: base prices, null promotion
columns. The module graph stays acyclic — checkout → loyalty → pricing — and
pricing still knows about neither.

## The Shopper link

Phase 26's `Shopper` model arrived on a sibling line of development, so when
this module was written `LoyaltyAccount.shopperId` was deliberately a bare
nullable column with no Prisma relation and no foreign key, guarded only by a
partial unique index reserving "at most one loyalty account per shopper per
tenant".

**Both have now merged.** The composite same-tenant foreign key and the relation
line were added in `20260916140000_loyalty_account_shopper_fk`, exactly the one
`ALTER TABLE` this section predicted — no column rename, no backfill, no data
migration. The API still never writes `shopperId` (there is no DTO field);
linking an account to a shopper remains open work.

## Surface

`/loyalty`, gated on the `loyalty` platform module, tenant-only.

| Route | Permission |
|---|---|
| `GET /loyalty/accounts`, `GET /loyalty/accounts/:id` | `loyalty-account:read` |
| `POST /loyalty/accounts`, `PATCH /loyalty/accounts/:id` | `loyalty-account:manage` |
| `GET /loyalty/accounts/:id/movements` | `loyalty-points:read` |
| `POST /loyalty/accounts/:id/{accrue,redeem}` | `loyalty-points:post` |
| `POST /loyalty/accounts/:id/adjust` | `loyalty-points:adjust` |
| `GET /loyalty/promotions…`, `GET /loyalty/quote` | `promotion:read` |
| `POST`/`PATCH` promotions, versions, rules | `promotion:manage` |
| `POST .../activate`, `POST .../rollback` | `promotion:activate` |

Managing a promotion and *making it take effect* are separate permissions, for
the same reason editing a price book version and activating it are.

## Operating it

1. Create a promotion (`POST /loyalty/promotions`).
2. Create a draft version, optionally copying the active one forward.
3. Replace its rules (whole-set semantics — a version is a complete snapshot).
4. Activate it. The previously active version is superseded by closing its
   window; nothing is rewritten.
5. Check `GET /loyalty/quote` for a product: the answer names the price version
   and the promotion version.
6. To undo: roll back to an earlier version. It is copied forward and
   activated, so the history reads forward.

Shelf labels are unaffected by all of the above. If the shelf should change,
make a price book version with reason `PROMOTION_BASE` instead — see
[pricing.md](pricing.md) and [esl.md](esl.md).
