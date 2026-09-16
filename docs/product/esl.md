# Electronic shelf labels

AGENTS.md states the rule this phase implements: *every integration goes
through an adapter interface owned by this repo*, and *core logic must compile
and test against the interface alone*. Phase 28 makes that structural for shelf
labels. No vendor name, SDK, protocol or endpoint appears anywhere in the ESL
domain code. A deployment names a vendor as a string on a gateway row, and the
runtime resolves that string to an adapter.

It also completes the second end-to-end journey in TESTING.md: **an admin price
change propagates to a label.**

## The model

**Gateway.** The vendor-side controller serving the labels in one store. It has
a tenant-unique code, a `vendorCode` that selects an adapter, a location, and a
status (`PENDING` → `ACTIVE` / `UNREACHABLE`, or operator-set `DISABLED`).

**Label.** One physical device on one gateway, identified by the vendor's own
`vendorLabelId`, unique per gateway. A label is `UNBOUND` until a product is
bound to it, `BOUND` once one is, and `RETIRED` when the hardware leaves the
shelf. Only a `BOUND` label is eligible for price propagation.

**Update job.** One queued push of content to one label. Jobs carry a trigger
(`PRICE_ACTIVATION`, `MANUAL_RERENDER`, `LABEL_BOUND`, `RECONCILIATION`), a
content fingerprint, a tenant-scoped idempotency key, an attempt budget, a
lease, and a closed-vocabulary error code.

## Vendor neutrality

`services/api/src/esl/ports.ts` is the whole boundary:

- `EslVendorPort` — `discoverLabels`, `readHealth`, `pushBatch`.
- `EslVendorRegistryPort` — `vendorCode` → adapter, returning `null` rather
  than throwing for a code nothing implements.

Adding a real vendor is **one new class** implementing `EslVendorPort` plus one
line in `EslVendorRegistry`'s constructor. No controller, service, repository,
schema or migration change. `SimulatedEslAdapter` is the adapter every
deployment has: it talks to nothing, so dev, test and CI exercise the entire
propagation path — batching, partial failure, backoff, retry, health — with no
hardware, no network and no vendor account. Its outcomes are deterministic
functions of the label id, so a test chooses an outcome by naming a label
rather than by stubbing the adapter.

Push is a **batch** verb because a price activation touches many labels at
once, and because one failing label must never hold up the rest: the adapter
returns one outcome per request, and the service records each on its own.

## Credentials

A gateway row stores `credentialRef` — an **opaque configuration key** such as
`ACME_STORE_01`. The adapter resolves it to a real credential from the
environment. The value is never logged, never returned to a caller, and never
written to an audit snapshot. The service rejects (rather than silently
redacts) a `credentialRef` or a `metadata` value that looks like a secret,
because a blanked reference would leave a gateway that cannot authenticate and
an operator with no explanation.

Vendor error text is kept for operators but screened with the same strict
free-text predicate the camera and pricing modules use, and dropped if it
fails. Errors thrown by an adapter are logged by class name only.

## Propagation

1. An admin activates (or rolls back to) a price book version.
2. `PricingService` commits the activation, then publishes a
   `PriceActivationEvent` on `PriceActivationHub`.
3. `EslService`, which registered with the hub at bootstrap, finds every
   `BOUND` label in that tenant showing an affected product — restricted to the
   book's location when the book is location-scoped, and skipping `DISABLED`
   gateways — and enqueues one job per label.
4. A processing pass claims jobs, groups them by gateway, resolves what each
   label should show **now**, and pushes through the gateway's adapter.
5. Success writes the label's rendered hash and version in the same transaction
   as the job's success, so "job succeeded" and "label shows this" can never
   disagree.

The dependency runs **one way**: `EslModule` imports `PricingModule` and
subscribes to the hub. Pricing never learns that labels exist, so the module
graph stays acyclic and a second consumer of activations costs nothing.

## Invariants

- **Delivery is best-effort, on purpose.** A shelf label that cannot be reached
  must never fail a price change: the price is in force the moment the
  activation transaction commits, whatever the hardware does afterwards. The
  hub isolates listener failures.
- **Reconciliation is the repair path.** `POST /esl/reconcile` compares every
  bound label's rendered fingerprint against the price actually in force and
  queues the difference. A listener that was down when a price changed is
  caught here, which is what makes the best-effort hand-off safe.
- **A replayed activation pushes once.** The job key is
  `activation:<versionId>:<labelId>` behind a unique
  `(tenantId, idempotencyKey)` index. Reconciliation keys on the drift it saw;
  an operator's re-render request never de-duplicates, because asking twice
  means it twice.
- **The push carries the price in force at push time,** not the one captured at
  enqueue time. Between the two the price may have moved again, and the shelf
  must end up showing the truth.
- **An already-correct label is a success, not a skip.** The shelf *is* right,
  and the job history still records that it was verified.
- **A rollback is an activation.** Subscribers hear about it exactly as they
  would a forward change; forgetting this is how a rolled-back price stays on a
  shelf.
- **At-least-once, never forever.** Each claim takes a lease and echoes the
  attempt it claimed as a fencing token, so a late result from a reclaimed
  attempt cannot commit over the live one. Failures back off exponentially and
  `FAIL` once the attempt budget is spent.
- **Disabling a gateway or retiring a label cancels its queued work** rather
  than burning attempts against hardware that is deliberately gone.
- **Retirement is one-way.** Re-registering hardware is a discovery, not an
  edit.
- **Every query is tenant-scoped at the repository layer,** and composite
  same-tenant foreign keys in migration SQL make a cross-tenant id unstitchable
  even if application code slipped.

## Surface

All routes are tenant-only, gated on the `esl` platform module, and split so
reading label health never implies the right to rebind hardware or drive the
queue.

| Route | Permission |
| --- | --- |
| `GET /esl/vendors` | `esl-gateway:read` |
| `GET /esl/gateways`, `GET /esl/gateways/:id` | `esl-gateway:read` |
| `POST /esl/gateways`, `PATCH /esl/gateways/:id`, `POST /esl/gateways/:id/discover` | `esl-gateway:manage` |
| `GET /esl/labels`, `GET /esl/labels/:id` | `esl-label:read` |
| `POST /esl/gateways/:id/labels`, `PATCH /esl/labels/:id`, `POST /esl/labels/:id/render` | `esl-label:manage` |
| `GET /esl/update-jobs` | `esl-job:read` |
| `POST /esl/update-jobs/process`, `POST /esl/update-jobs/reclaim-expired`, `POST /esl/reconcile` | `esl-job:process` |

## Operating it

1. Register a gateway with `vendorCode: SIMULATED` (or a real code from
   `GET /esl/vendors`) and the store it serves.
2. `POST /esl/gateways/:id/discover` to register the labels it can see, or
   `POST /esl/gateways/:id/labels` to add one by hand.
3. `PATCH /esl/labels/:id` with a `productId` to bind it — which queues an
   immediate render, because a freshly bound label is showing nothing.
4. Activate a price book version. `POST /esl/update-jobs/process` runs a pass;
   `GET /esl/update-jobs` shows what happened and why.
5. `POST /esl/reconcile` at any time to repair drift.

The admin web exposes all of this at **Shelf labels**.
