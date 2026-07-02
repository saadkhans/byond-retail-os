# BYOND Retail OS

BYOND is an edge-first, cloud-managed, multitenant retail operating system. Computer vision proposes events, the inventory ledger validates them, and checkout routes the result — with human review for low-confidence events, swappable models, abstracted hardware, and enterprise-grade audit and security.

## Repository layout

```
apps/            User-facing applications
  admin-web/     Admin web console
  mobile-app/    Shopper / staff mobile app
services/        Backend services
  api/           Core multitenant API
  edge-runtime/  In-store edge runtime
  cv-pipeline/   Computer vision event pipeline
packages/        Shared workspace packages
  shared/        Shared types and utilities
  config/        Shared lint/TS/build configuration
  ui/            Shared UI components
infra/           Infrastructure
  docker/        Dockerfiles and compose configs
  github-actions/ Reusable CI building blocks
docs/            Documentation (architecture, product, security)
scripts/         Repo automation scripts
```

## Key documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — system principles and design invariants
- [AGENTS.md](AGENTS.md) — AI agent roles and hard rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch, PR, and review workflow
- [SECURITY.md](SECURITY.md) — security requirements and tooling
- [TESTING.md](TESTING.md) — required test categories

## Getting started

```bash
corepack enable
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

All scripts are placeholders until the first packages land; they exist so CI runs green from day one.
