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
