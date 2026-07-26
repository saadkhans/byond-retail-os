# ARCHITECTURE.md — BYOND System Architecture

BYOND is a retail operating system built on the following principles. These are design invariants: new code must fit them, and deviations require an explicit, documented decision.

## Core principles

### Edge-first
Stores keep operating when the cloud is unreachable. The edge runtime (`services/edge-runtime/`) handles in-store decisions locally — CV event processing, checkout, ESL updates — and syncs with the cloud when connectivity allows.

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
