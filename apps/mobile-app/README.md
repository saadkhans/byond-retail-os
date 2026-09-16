# BYOND Shopper App

The shopper-facing surface of the store loop: entry, live basket, exit and
payment, driven against the Phase 26 store flow.

## Why this is a web app and not React Native

This repository has no native mobile toolchain — no Expo, no Metro, no
CocoaPods, no Gradle — and CI runs plain `pnpm` lint / typecheck / test /
build over the workspace. Introducing one would produce an app that could
not be built or verified here, which is worse than no app. So this is a
**mobile-first web app** on the same stack as `apps/admin-web` (Vite + React
+ TypeScript + Vitest), which lints, typechecks, tests and builds under the
existing recursive scripts with no CI change. A shopper opens it from a QR
code at the door; a native shell can wrap the same screens later without
changing the contract below.

It ships with a `lint` script from its first commit. `apps/admin-web` did
not, and went unlinted in CI for the project's entire life.

## The four screens and the endpoints they drive

| Screen | File | Endpoint |
| --- | --- | --- |
| Entry | `src/screens/EntryScreen.tsx` | `POST /shopper/session` |
| Live basket | `src/screens/BasketScreen.tsx` | `GET /shopper/basket` (polled) |
| Exit | `src/screens/ExitScreen.tsx` | `POST /shopper/exit` |
| Payment | `src/screens/PaymentScreen.tsx` | the result of `POST /shopper/exit` |

Those three endpoints are the app's entire network surface, pinned by
`src/app-safety.spec.ts`.

## The credential

The app holds a **journey-scoped credential**, not a staff token. It is the
32-byte entry secret Phase 26 issues at the door: single-use for redemption,
and afterwards bound to exactly one journey in exactly one tenant
(`StoreEntryToken.redeemedJourneyId` is UNIQUE). The API resolves the tenant,
the store and the journey from that credential server-side, so the app never
names any of them — there is no tenant id in this codebase at all.

* It travels in `Authorization: Shopper <secret>`, never in a URL.
* It lives in `sessionStorage`, which dies with the tab, plus an in-memory
  copy so the app still works when storage is blocked.
* It is stored only after the API accepts it, and wiped on any failure.

## No card data

There is no card field, no payment form and no payment handler anywhere in
this app, and `src/app-safety.spec.ts` fails if one appears. Money moves
through the API's provider-neutral payment abstraction (`SIMULATED` is the
only provider this repository has), driven by Phase 26's exit. This app
reports what that state machine did.

## Honest about SHADOW

Phase 26's autonomy policy defaults to `SHADOW`: the store observes and
changes nothing. In that configuration the basket legitimately stays empty,
and the basket screen says so in those words rather than implying detection
is running. See `detectionNotice` in `src/shopper-flow.ts`.

## Running it locally

```
pnpm --filter @byond/mobile-app run dev     # http://localhost:5174
```

The API's CORS allowlist is explicit and defaults to the admin shell alone,
so start the API with:

```
CORS_ORIGINS=http://localhost:5173,http://localhost:5174
```

Get an entry code from the admin shell (`POST /store-flow/entry-tokens`,
needs `store-flow:operate`). It is returned once and lasts 120 seconds by
default.

## Tests

```
pnpm --filter @byond/mobile-app run lint
pnpm --filter @byond/mobile-app run typecheck
pnpm --filter @byond/mobile-app run test
```

The tests are state-machine tests, not markup tests: an expired credential, a
redeemed-twice credential, a settlement blocked by pending review, a payment
that did not go through, an empty basket under `SHADOW`, and a lost
connection that must not make a basket appear to vanish.
