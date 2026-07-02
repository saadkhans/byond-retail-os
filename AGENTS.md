# AGENTS.md — AI Agent Roles and Rules

This file governs every AI agent working in this repository.

## Roles

- **Claude Code is the primary builder.** It designs and implements features, writes code and documentation, and drives day-to-day development.
- **Codex is the lead reviewer, tester, refactorer, and release-quality checker.** It reviews every pull request, strengthens test coverage, refactors for quality, and gates releases.

## Workflow rules

- **No agent may commit directly to `main`.** Ever.
- **All work must happen on feature branches and pull requests.** Every change reaches `main` only through a reviewed PR.

## Product invariants (hard rules — never violate)

### Tenancy
- **All tenant-scoped queries must enforce tenant isolation.** Every query touching tenant data must be scoped by tenant ID at the data-access layer; never rely on the caller to filter.

### Inventory
- **Inventory stock must never be overwritten silently.** No direct `UPDATE stock SET quantity = X` style mutations.
- **All inventory changes must go through the inventory ledger.** Stock levels are derived from an append-only ledger of inventory events; the ledger is the source of truth.

### Pricing
- **Pricing changes must be versioned, auditable, and reversible.** Every price change creates a new version with who/when/why, and any version can be rolled back.

### Payments
- **Payment card data must never be stored directly.** Use tokenization via the payment provider; raw PANs, CVVs, and track data must never touch our storage, logs, or memory dumps we control.

## Vendor neutrality

- **Use adapter interfaces for external systems.** Every integration goes through an adapter interface owned by this repo.
- **Do not hardcode one LLM, CV model, ERP, POS, payment provider, ESL vendor, or hardware vendor.** Concrete vendors are plug-ins behind adapters; core logic must compile and test against the interface alone.

## When in doubt

If a change might violate any rule above, stop and raise it in the PR description instead of proceeding. Codex must flag violations as blocking review comments.
