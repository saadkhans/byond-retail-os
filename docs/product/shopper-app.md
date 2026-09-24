# The shopper application (Phase 35)

The shopper-facing surface of the store loop: entry, the live basket, exit
and payment, driven against the Phase 26 store flow.

Two pieces ship together:

* `apps/mobile-app` — a mobile-first web app, four screens.
* `services/api/src/shopper` — the narrow API surface those screens drive.

---

## Why a web app, not React Native

The repository has no native mobile toolchain — no Expo, no Metro, no
CocoaPods, no Gradle — and CI runs plain `pnpm` lint / typecheck / test /
build across the workspace. Adding a native toolchain here would produce an
app that could not be built or verified in this repository, which is worse
than no app at all.

So the shopper app is a **mobile-first web app** on the same stack as
`apps/admin-web` (Vite + React + TypeScript + Vitest). It lints, typechecks,
tests and builds under the existing recursive scripts with no CI change. A
shopper opens it from a QR code at the door. A native shell can wrap the same
four screens later without changing a line of the contract below, because the
contract is three HTTP endpoints and one credential.

It ships with a `lint` script from its first commit; `apps/admin-web` did not,
and went unlinted in CI for the project's entire life.

---

## The principal: a journey-scoped credential, not a staff token

Every `/store-flow` route is a STAFF route — tenant-scoped, RBAC-gated,
module-gated. A shopper has none of those things and must never be handed any
of them: an access token that can read `/store-flow/journeys` can read every
shopper in the tenant. So the shopper gets a principal of its own.

That principal is the entry credential Phase 26 already issues:

* 32 bytes of entropy, returned exactly once, stored only as a SHA-256 digest;
* single-use for redemption, burned through a guarded `updateMany` so
  concurrent redemptions race at the database;
* bound on redemption to exactly one journey —
  `StoreEntryToken.redeemedJourneyId` is UNIQUE, so one credential can only
  ever open one journey.

After redemption, the same secret is what proves "I am the shopper on that
journey", for a bounded window (`SHOPPER_SESSION_MAX_SECONDS`, four hours —
longer than any visit, short enough that a secret left in a browser is
worthless by the time anyone finds it). The credential's own redemption TTL
(120 s by default) is untouched.

**It names nothing.** There is no tenant id, store id, unit id, journey id or
shopper id in any request the app can make. Every one of them is read off the
credential row server-side. A shopper cannot name another tenant's data, so a
shopper cannot reach it.

### Where the credential lives

`Authorization: Shopper <secret>`, always a header — never a query string and
never a path segment, because those end up in browser history, in `Referer`
headers on the next navigation, and in the access log of every proxy in
between. `Bearer` is deliberately NOT accepted on the shopper surface: a staff
token must never authenticate a shopper route, and a shopper credential must
never be mistaken for one.

In the browser it lives in `sessionStorage` (which dies with the tab, unlike
the persistent store beside it) plus an in-memory copy, so the app still works
when storage is blocked entirely. It is written only after the API accepts it,
and wiped on any failure.

---

## The four screens

| Screen | Endpoint | What it has to get right |
| --- | --- | --- |
| Entry | `POST /shopper/session` | Expired, already-used and revoked codes each get their own instruction; unknown and wrong get the same one, because the API refuses to say which |
| Live basket | `GET /shopper/basket` (polled) | Honesty about `SHADOW`, where an empty basket is the correct answer |
| Exit | `POST /shopper/exit` | A pending review is a state ("checking with a colleague"), not an error |
| Payment | the result of `POST /shopper/exit` | Report what the simulated provider did; collect nothing |

Those three endpoints are the app's entire network surface, pinned by
`apps/mobile-app/src/app-safety.spec.ts`.

### Entry

Phase 26 answers `409` with a reason code for a credential that EXISTS but
cannot be used, and `404` for one that is unknown OR wrong. The app preserves
that split exactly: a shopper whose code expired while they queued is told to
fetch a new one, a shopper whose friend already used theirs is told the same
in different words, and a shopper who mistyped is told only that it did not
work. No reason code, status or endpoint reaches the copy on screen.

### Live basket, and telling the truth about SHADOW

Phase 26's autonomy policy defaults to `SHADOW`: the store observes and
changes nothing. In that configuration the basket legitimately stays empty no
matter what the shopper picks up.

Implying otherwise would be a lie in both directions — it would make a working
store look broken, and it would make a shopper believe items were being
counted when they were not. So the basket screen says, in those words, that
the store is not adding items automatically today and that a colleague will
check them out. Under `PROPOSE` it says a colleague confirms each item; under
`AUTO_APPLY` it says the basket updates as they shop.

### Exit

Phase 26 refuses to settle while any observation still waits for a human —
an unreviewed pickup must never be silently billed OR silently dropped. The
app surfaces `BLOCKED_ON_REVIEW` as **"Checking with a colleague"**, with a
"check again" action, not as an error. Dressing a correct refusal as a failure
would train people to walk away from it.

An exit that fails outright returns the shopper to their basket with it
intact, because Phase 26's exit is replay-safe: trying again is genuinely
safe.

### Payment

There is no payment form, no payment field and no payment handler anywhere in
this app, and a grep guard fails if one appears. Money moves through Phase 6's
provider-neutral intent state machine (`SIMULATED` is the only provider this
repository has), driven by Phase 26's exit. This screen reports what that
state machine did.

A payment that did not go through is shown as an instruction ("pay at the
counter"), never as a retry button: retrying payment is a decision a person
makes, not a side effect of tapping twice on a phone.

---

## What makes a public API surface safe

`/shopper/*` routes are `@Public()` by necessity — the caller is a phone with
no user identity. That follows the precedent this repository already set for a
non-user principal in `POST /edge/register`. The checks the staff guards would
have applied are performed explicitly in `ShopperService`, in the same order
and to the same standard:

| Staff guard | Shopper equivalent |
| --- | --- |
| `AuthGuard` resolves the tenant from the user row | The tenant is resolved from the credential row; never from a body, header, query or path |
| Login/`AuthGuard` refuse a non-ACTIVE tenant | A suspended or archived tenant is refused |
| `@RequireModule('store-flow')` | `store-flow` must be ENABLED for that tenant |
| `@RequirePermissions(...)` | The credential authorizes ONE journey and three operations: see your basket, leave, read the outcome |
| The audit trail wants a real actor | Actions are attributed to the operator who ISSUED the credential — a real, active user of that tenant, and the accountable party for a credential they handed out. A credential whose issuer is gone opens nothing. |

Every session failure gives one generic `401`, so the surface cannot be used
to probe whether a secret exists, which tenant it belongs to, whether that
tenant is active, whether the module is on, or when a session expired.

The module **writes nothing of its own**. Every effect a shopper causes goes
through `StoreFlowService` — the same method, the same idempotency keys, the
same review gate, the same inventory validation and the same payment
abstraction an operator drives by hand from the admin surface. There is no
second settlement path.

`services/api/src/shopper/boundary.spec.ts` fails if any of that changes: a
database write, a transaction, a tenant id read from a request, a card-data
identifier, a direct import of checkout/orders/payments/vision/inventory, or a
`@Public()` route outside the single controller.

### What a shopper is allowed to see

The response is an allowlist, assembled field by field from narrow reads — not
a redaction of a wider object, so nothing a future Phase 26 field adds can
arrive by accident. Absent by construction: the tenant id, the store and unit
ids, the shopper id, the checkout session id, the order id, catalog product
ids, the payment intent id, the autonomy policy's confidence thresholds, every
projection row, every score, and anything at all about any other journey.

---

## Running it

```bash
pnpm --filter @byond/mobile-app run dev     # http://localhost:5174
```

The API's CORS allowlist is explicit and defaults to the admin shell alone, so
start the API with:

```
CORS_ORIGINS=http://localhost:5173,http://localhost:5174
```

Get an entry code from the admin shell's Store flow page (`POST
/store-flow/entry-tokens`, permission `store-flow:operate`). It is returned
once and lasts 120 seconds by default.

---

## Tests

The valuable tests here are state-machine tests, not markup tests. They cover
the states a real shopper hits: an expired credential, a redeemed-twice
credential, a settlement blocked by a pending review, a payment that did not
go through, an empty basket under `SHADOW`, and a lost connection — which must
never make a basket appear to vanish.

```bash
pnpm --filter @byond/mobile-app run lint
pnpm --filter @byond/mobile-app run typecheck
pnpm --filter @byond/mobile-app run test
pnpm --filter @byond/api run test --ci --maxWorkers=4
```
