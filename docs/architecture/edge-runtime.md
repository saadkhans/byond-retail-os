# Edge runtime

The edge runtime is the in-store data plane. ARCHITECTURE.md's first principle
is edge-first: "Stores keep operating when the cloud is unreachable." This
service is what makes that true. The cloud stays the control plane and the
authoritative record; the edge keeps trading when the link is down and
reconciles when it returns.

It lives in `services/edge-runtime` and is a NestJS service with no database.
Its durable state is a directory of files.

## What it holds

Two shapes, deliberately only two.

**Records** are the working set the cloud pushes down: units, devices, the
catalog snapshot, the planogram, resolved prices. A record is replaceable and
the newest version wins.

**Logs** are append-only streams of facts: the inventory ledger, the outbox,
the inbox, conflicts, dead letters, and CV proposals as observed. A log entry is
never updated and never deleted.

Stock levels and outbox progress are projections over those logs. That is what
makes a silent overwrite structurally impossible on the edge, exactly as the
ledger does in the cloud. `LocalLedgerService` caches its projection and also
exposes a full replay, so a test can prove the cache never drifts from the
facts.

The store adapter writes records through a temporary file and a rename, so a
crash leaves either the old record or the new one. Log entries are one JSON
object per line, appended and fsynced; a crash mid-append can leave a torn final
line, which readers skip and the next writer's sequence re-uses. Ids are hashed
into filenames, which removes every path-traversal question rather than trying
to sanitise ids that arrive from the cloud and from devices.

Nothing that looks like card data, a secret, a media locator or raw bytes can be
persisted at all: `assertPersistable` refuses it rather than masking it, because
a caller trying to store such a thing has a defect that masking would hide.

## One node, one tenant

AGENTS.md requires tenant isolation at the data-access layer rather than by
convention. A cloud service enforces that per query; an edge node has a simpler
and stricter option, because it serves exactly one tenant at one location.

The store is sealed on first open to `EDGE_TENANT_ID`, `EDGE_LOCATION_ID` and
`EDGE_DEVICE_ID`, and the runtime refuses to start against a store sealed to
anything else. Without that, a box re-provisioned to a second retailer — or
pointed at a directory restored from another site — would resume the first
tenant's ledger, review queue and catalog and push their facts up under the new
device's credential. The directory is evidence, so a refusal never rewrites or
clears it; an operator decides. The error names the fields that differ and never
their values, so a misconfigured node cannot disclose the other tenant's
identifiers through its own logs.

Isolation applies to what arrives, too. "The cloud wins" stops at the tenant
boundary: a configuration entry naming a tenant other than the sealed one is
never applied however new its version, and is recorded as a conflict whose
detail omits the foreign tenant id. The watermark still advances past it, so one
misrouted resource cannot wedge the node into re-pulling it forever. The inbox
log gets a receipt rather than the entry — resource type, id, version and the
reason it was refused — so an operator can see that something misrouted arrived
without the other tenant's payload coming to rest on this retailer's box.

Nor can configuration move stock. A cloud entry may replace the catalog, the
planogram or a price; it may not write a ledger fact, because an edge node
proposes and the cloud validates. `stock-authority.spec.ts` pins that: nothing
under `src/sync` may name the ledger at all.

Nothing travels the other way. The outbox body carries no tenant id at all: the
control plane resolves tenancy from the device credential, and a node that
announced its own tenant would be asking the cloud to trust a caller-supplied
scope — exactly what the tenancy rule forbids.

## The sync contract

Direction decides ownership, and ownership decides who wins.

**The cloud owns configuration.** It flows down through the inbox carrying the
cloud's change sequence: strictly increasing across the whole configuration
stream, and therefore increasing per resource too. Both properties are
load-bearing. Because it is global, the node tracks what it has seen with one
watermark and asks for everything after it; a per-resource version would need a
cursor per resource and would silently lose an update whenever one resource's
numbering ran behind another's. Because it also increases per resource, an entry
whose version is not greater than the one already applied to that resource is
stale and is ignored. That single check is what makes applying the same batch
twice a no-op, and therefore makes reconnection convergent.

**The edge owns locally-observed facts.** Ledger movements, CV proposals and
review decisions flow up through the outbox and the cloud never overwrites them.
They are history, not editable state.

**Anything else is a conflict**, and a conflict is recorded and surfaced rather
than resolved by guessing. Stale configuration, a fact the cloud refused, and a
delivery that exhausted its attempt budget each write to the conflicts log and
appear in the metrics snapshot.

Delivery is at-least-once and strictly in order, so the outbox cursor is a
single number. Every operation carries an idempotency key that is stable across
retries, so a replay after a crash re-sends the same key and the cloud holds the
fact once. A head entry the cloud will never accept would otherwise block the
queue forever, so after the attempt budget it is dead-lettered and the cursor
moves on.

The outbox log is append-only and is never truncated, not even when the backlog
exceeds its bound. Dropping an entry only ever means advancing the cursor past
it and recording why; the fact stays on disk for an operator. Losing a
locally-observed fact silently is the one outcome this design refuses.

Losing connectivity is not an error path. A sync pass reports offline, leaves
the outbox alone apart from an attempt increment, and the store keeps trading.
Retries back off exponentially to a ceiling.

## Offline decisioning

`OfflineDecisionService` records every proposal as observed before it decides
anything, so the observation survives even if the decision is later disputed.
Then the policy runs.

The policy encodes the product invariant verbatim. Computer vision only
proposes. Inventory validates the proposal against the local ledger projection:
a pickup the ledger cannot support goes to review, not to stock. A proposal
below the confidence threshold goes to review. A product the local catalog does
not know goes to review. Only a confident, known, ledger-supported stock event
is applied locally, and even then the proposal is still forwarded to the cloud,
because the control plane remains the authoritative record of what the cameras
claimed.

An operator can clear the local review queue while still offline. Approving
applies the movement the policy declined to apply automatically; the decision
itself is forwarded as an append-only fact either way. A decided item is
terminal.

## Hardware abstraction

Cameras, scales, electronic shelf labels, gates and point-of-sale peripherals
each sit behind a port this repository owns, carrying `adapterKey` and `version`
like the computer-vision ports do. No vendor type appears in any signature, so
supporting a new vendor means writing a driver, not touching core logic.

Neutrality is enforced by grep, the way the API's inference and video-ingest
modules enforce theirs: `vendor-neutrality.spec.ts` fails on a vendor name
anywhere in `src`, on a vendor SDK or device transport in `package.json`, on any
file outside the composition root importing a concrete driver, and on a device
kind that has no simulated driver.

Every kind ships a simulated driver, which is why the whole suite runs with no
hardware, no network and no database.

A failing device degrades and the runtime keeps going: one missed heartbeat is a
blip and marks the device degraded, a second means it is gone. Reconnection is
attempted on every heartbeat, and health surfaces through the metrics snapshot
rather than by throwing into a caller's path. A store does not stop trading
because a shelf label lost power.

## Operations

`GET /health` is deliberately minimal — status, whether the store is writable,
and whether the cloud is reachable — matching the cloud API's health endpoint.
`GET /metrics` is richer: connectivity, last sync, outbox depth, dead letters,
conflicts, ledger size, proposals observed, reviews pending, and per-device
health.

Because the snapshot describes the store's state, the operations server binds to
loopback unless an operator deliberately widens `EDGE_OPS_BIND_ADDRESS`.

## Configuration

Validated at boot, in the style of the cloud API's environment validation.
Failures report property names only, because the cloud URL and token are
credentials.

Transport security is not a preference: the control-plane URL must be https, and
plaintext http is accepted only for loopback while `NODE_ENV` is explicitly
development or test. A URL with embedded credentials is rejected outright, and a
cloud URL configured without a token fails fast rather than running permanently
unauthenticated. A node with no cloud configured at all runs deliberately
offline, accumulating facts, rather than discarding them into a no-op client.

See `.env.example` for the full set.

## Extension points left for later phases

These are marked in the code and are the places the remaining phases attach.

**Pricing** supplies resolved prices as a configuration resource type that the
inbox already understands, and the electronic shelf label port already takes
resolved display fields, so a price change becomes a label render with no change
to the abstraction.

**The store loop** adds a local checkout projection alongside the ledger; the
decision path already produces the basket-affecting facts it will consume.

**Electronic shelf labels** get a real vendor driver behind `EslDriver`; the
simulated one records what it was asked to show.

**The CV pipeline service** feeds `OfflineDecisionService.ingest` with the
proposals it currently receives directly.
