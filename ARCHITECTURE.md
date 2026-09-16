# ARCHITECTURE.md — BYOND System Architecture

BYOND is a retail operating system built on the following principles. These are design invariants: new code must fit them, and deviations require an explicit, documented decision.

## Core principles

### Edge-first
Stores keep operating when the cloud is unreachable. The edge runtime (`services/edge-runtime/`) is a real NestJS service and is what makes this true rather than aspirational. It has **no database**: its durable state is a directory of files, split into replaceable *records* the cloud pushes down (units, devices, the catalog snapshot, the planogram, resolved prices) and append-only *logs* of facts (the local inventory ledger, the outbox, the inbox, conflicts, dead letters, and CV proposals as observed). Stock levels and outbox progress are projections over those logs, so a silent overwrite is structurally impossible on the edge exactly as it is in the cloud.

What it does today: local CV-proposal ingestion and offline decisioning with a local review queue, an append-only local ledger, at-least-once ordered sync through an outbox with stable idempotency keys, a hardware abstraction layer with a simulated driver for every kind (cameras, scales, shelf labels, gates, POS peripherals), and a loopback-bound `GET /health` + `GET /metrics` ops surface.

What it does **not** do yet, and what an earlier version of this document wrongly claimed it did: it does not run checkout locally, and it does not drive ESL updates. Those are cloud-side today (`services/api/src/checkout`, `services/api/src/esl`). The edge runtime has the extension points — a local checkout projection alongside the ledger, and an `EslDriver` port whose only implementation is simulated — but the loop through them is not closed. Treat "edge-first" as a proven property of the ledger, sync and decisioning layers, and as a stated direction for checkout and labels.

A node is sealed on first open to one `EDGE_TENANT_ID` / `EDGE_LOCATION_ID` / `EDGE_DEVICE_ID` and refuses to start against a store sealed to anything else, which is how the multitenancy rule below is enforced on a box that serves exactly one retailer. See [docs/architecture/edge-runtime.md](docs/architecture/edge-runtime.md).

### Cloud-managed
Configuration, fleet management, model distribution, tenant administration, and analytics live in the cloud (`services/api/`). The cloud is the control plane; the edge is the data plane.

### Multitenant
One deployment serves many retailers. Every entity is tenant-scoped, every query enforces tenant isolation at the data-access layer, and no tenant can ever observe another tenant's data. See [AGENTS.md](AGENTS.md) for the hard rule.

### Inventory-ledger based
Stock is never a mutable number. All inventory movement — receiving, sale, shrink, correction, transfer — is an append-only ledger event, and stock levels are projections derived from the ledger. This gives full auditability and makes silent overwrites structurally impossible.

## Event flow

### CV proposes, inventory validates, checkout routes
The computer vision pipeline (`services/cv-pipeline/`) only ever *proposes* events (e.g., "shopper picked item X"). The inventory system *validates* proposals against the ledger and known state. Checkout *routes* the validated result to the right fulfillment path (self-checkout, staffed lane, app payment). CV output is never trusted as ground truth on its own.

### Human review for low-confidence events
Every proposed event carries a confidence score. Events below the confidence threshold are routed to a human review queue instead of being auto-applied. Thresholds are tenant-configurable.

### Event-driven CV inference (Phase 9 foundation)
The CV pipeline is event-driven, in three tiers, so heavy models never run on every full-resolution frame:

1. **Continuous lightweight tracking** — people/hand/shelf-zone tracking runs on a DOWNSCALED stream (e.g. 640p) on the smart camera, a local edge box, or a server. It produces tracking metadata, never product decisions.
2. **Trigger layer** — only meaningful moments (a hand entering a shelf zone, a suspected shelf change, a suspected cart insertion, a customer exit) create an **inference job**.
3. **Heavy inference on triggered crops only** — product recognition / SKU classification (and OCR where useful) runs on HIGH-RESOLUTION crops from the 6MP/8MP source, only for triggered jobs. A VLM is a fallback VERIFIER that receives cropped product patches only — never full-store video.

Phase 9 ships the cloud-side foundation for tier 2→3: a provider-neutral `InferenceJob` domain with a deterministic, tenant-safe, database-backed queue behind an `InferenceQueuePort` abstraction, a provider-neutral `InferenceAdapter` contract, and a SIMULATED adapter only. Claims are lease-based: every claim takes a bounded lease and increments an attempt counter, and a RUNNING job whose worker crashed (lease expired) is reclaimed on the next claim pass — back to QUEUED while attempts remain, FAILED with `LEASE_EXPIRED` once the attempt budget is spent, every reclaim audited as a system action; an explicit operator endpoint (`POST /inference/jobs/reclaim-expired`) runs the same sweep on demand so a stranded job is recoverable from the admin UI, and complete/fail requests carry the caller-observed claim attempt as a fencing token, so a stale worker whose lease was reclaimed cannot commit over the live attempt. A successful result converts into a Phase 7 `VisionEvent` through the existing ingest contract (PENDING_REVIEW; the basket changes only on an approved review), carrying the SOURCE-reported `occurredAt` so delayed jobs keep correct event chronology. The app database stores references, ids, scores, candidates, and safe metadata — never raw media, storage keys, signed URLs, or credentials (descriptors are screened by key AND by value: URI schemes, media file extensions, and presigned-URL signatures are all rejected).

**Future adapters (explicitly NOT implemented in Phase 9 — no runtime dependency was added and no model executes):** message-broker queue adapters (e.g. Redis/NATS/MQTT/Kafka) behind `InferenceQueuePort`; batched model serving (Triton-style) behind `InferenceAdapter`; camera ingestion feeds (GStreamer-style pipelines, with DeepStream as an optional premium NVIDIA adapter and FFmpeg as a utility layer) feeding the trigger layer; Celery/Redis-style workers for offline/background jobs; and smart cameras streaming lightweight tracking metadata directly. Per-claim fencing already ships in Phase 9 (complete/fail carry the observed claim attempt); a real multi-worker fleet may harden this further with unguessable lease tokens. Each arrives as an adapter behind the Phase 9 contracts, never as a rewrite.

### Video ingestion & crop extraction (Phase 10 MVP)
Phase 10 is the first controlled on-ramp for REAL test footage into the tier 1→2 flow above — without any production camera runtime. A tenant admin uploads a short, controlled test clip (10–30 s, fixed camera, known shelf zone); the platform records a tenant-safe `VideoAsset` (metadata + SHA-256 checksum + an INTERNAL, server-generated storage key), probes it, and extracts `VideoArtifact` rows (full FRAMEs or manual CROPs with a validated box and a closed-vocabulary reason). A CROP artifact then creates a Phase 9 inference job whose input descriptor references the artifact BY OPAQUE ID ONLY — the Phase 9 media policy screens it again, so storage keys, paths, URLs, and bytes structurally cannot ride along. From there the existing flow applies unchanged: simulated adapter → ranked candidates → Phase 7 `VisionEvent` (PENDING_REVIEW; basket changes only on approved review).

Storage is a LOCAL/DEV adapter behind a `VideoStoragePort` (gitignored root, root-confined keys, no public or signed URLs, no cloud credentials — object storage arrives later behind the same port). Extraction runs behind a `VideoFrameExtractorPort` with two adapters: a deterministic SIMULATED extractor (the default — dev/test/CI need no media tooling) and an OPTIONAL local system-binary adapter (ffmpeg/ffprobe from PATH, opt-in via `VIDEO_FFMPEG_ENABLED=true`, argument vectors only, no shell, controlled errors that never echo paths or stderr; never an npm dependency). Upload safety is layered: container allowlist (extension + declared MIME + magic bytes), conservative configurable size limit, filename traversal rejection, credential/payment screening, tenant isolation with same-tenant composite FKs, RBAC (`video-asset:read/manage/process/delete`), module gating (`video-ingest`), and full audit logging. Raw media NEVER enters the app database; artifact rows are internal references (no download URLs in Phase 10).

**Explicitly NOT in Phase 10:** production camera/streaming runtime, GStreamer/DeepStream/Triton, broker-backed queues, real model execution, VLM integration, cloud/object media storage, public or signed media URLs, and committed media of any kind (uploads, frames, crops live only under the gitignored local storage root).

### The retail domain (Phases 25–35)

The event flow above is the CV half. The commercial half now exists in the cloud API and follows one shape: **versioned, append-only, derived on read.** Nothing in it mutates a figure in place.

- **Pricing** (`services/api/src/pricing/`, `/price-books`, `/prices`) — a price is a row in a version of a price book, never a field on a product. Changing a price publishes a new version; rollback copies an earlier version forward rather than rewriting history. A basket line locks its price when it is added, so an activation mid-shop cannot re-price an open basket, and a priced order becomes the authority on what may be charged.
- **The store loop** (`services/api/src/store-flow/`, `/store-flow`) — entry credential → observations → basket → exit → order → payment, with a versioned per-tenant/per-store autonomy policy. The default is `SHADOW`: observe only, change nothing. Every step is idempotent, and a journey with anything still awaiting review will not settle.
- **Returns, refunds and reconciliation** (`services/api/src/returns/`, `/returns`, `/cycle-counts`, `/shrink-events`) — the reverse flow. Goods return through the ledger; money returns through the payments abstraction, capped at what was captured. Stocktake variance (a real operator finding) and ledger drift (a platform defect) are kept in separate blocks so they can never be averaged together.
- **Electronic shelf labels** (`services/api/src/esl/`, `/esl`) — activating a price version queues a push to every bound label. Vendor-neutral behind an adapter port; the only shipped adapter is simulated. Delivery is best-effort by design: an unreachable label must never fail a price change.
- **Loyalty and promotions** (`services/api/src/loyalty/`, `/loyalty`) — promotions compose *on top of* a resolved price version and never inside it, so the price book stays the single explanation of base price. Points are an append-only ledger. Promotions do not stack: exactly one applies, the largest discount.
- **Reporting** (`services/api/src/reporting/`, `/reports`) — read-only and derived on read. No roll-up tables, no cache, no scheduled job, and no new Prisma model, so reporting can never become a second set of books. Every response says when it was computed and which tables it came from. `read-only.spec.ts` pins that the module contains no destructive Prisma call.
- **Procurement** (`services/api/src/procurement/`, `/suppliers`, `/supplier-products`, `/purchase-orders`, `/goods-receipts`) — stock arrives through a purchase order and a goods receipt that writes the same append-only ledger a sale does, instead of through a manual adjustment. Purchase cost and retail price are deliberately separate.
- **The shopper application** (`services/api/src/shopper/`, `/shopper`) — see below.

### The public API surface

Until Phase 35 every route in this repository required an authenticated user or a device token. The shopper application introduces the first routes intended to be reached from an untrusted device on a hostile network: `POST /shopper/session`, `GET /shopper/basket`, `POST /shopper/exit`.

The design invariant is that the *principal* changes, not the guard. A shopper presents `Authorization: Shopper <secret>` — the single-use store entry credential the door already issued — and it authorizes exactly one journey in exactly one tenant and nothing else. The app never names a tenant, store, journey or shopper; every identifier is read off the credential server-side, so there is no parameter a shopper could tamper with to reach someone else's data. The three routes are `@Public()` by exception and are kept in one file so the surface stays countable; `services/api/src/shopper/boundary.spec.ts` pins that count, and `apps/mobile-app/src/app-safety.spec.ts` pins that the client makes no other call. The app contains no payment form, field or handler of any kind.

This is the highest-risk surface in the repository and the one most deserving of a human security review before it reaches production.

### Tenant isolation at the write predicate

Multitenancy (above) is enforced at the data-access layer by `TenantScopedRepository`. A repo-wide sweep hardened every destructive write — `delete`, `deleteMany`, `update`, `updateMany` — to carry `tenantId` in its predicate rather than addressing a row by `id` alone, and `services/api/src/prisma/tenant-write-predicate.spec.ts` walks the whole API source tree to keep it that way, with an allowlist whose every entry must explain itself.

Its limit is worth stating plainly: **the guard is textual.** It proves the token `tenantId` appears in the predicate of a destructive write. It cannot prove that the value bound to it is the caller's tenant. Closing that gap properly means a Prisma client extension that refuses a tenant-scoped write with no tenant filter at the driver, where the value is knowable.

## Swappability

### Model-swappable
CV and LLM models are referenced through versioned model interfaces. Swapping a model is a configuration change plus validation run, not a code rewrite.

### Hardware-abstracted
Cameras, scales, ESLs, POS hardware, and gates sit behind hardware abstraction interfaces in the edge runtime. Supporting a new vendor means writing a new driver, not touching core logic.

### Adapter-first
Every external system — ERP, POS, payment provider, ESL vendor, LLM, CV model — is integrated through an adapter interface owned by this repo. Core domain logic depends only on the interfaces. No vendor SDK types leak into domain code.

## Security and audit

### Enterprise-grade audit and security
Every state change is attributable (who/what/when/why), tenant-isolated, and captured in audit logs. RBAC governs all access, data is encrypted in transit and at rest, and payment card data is never stored directly. See [SECURITY.md](SECURITY.md).
