# CONTRIBUTING.md — Workflow and Review Requirements

## Feature branch workflow

- `main` is protected. **Nobody — human or agent — commits directly to `main`.**
- All work happens on feature branches cut from `main` (or `dev` where applicable).
- Branch naming: `feat/<short-description>`, `fix/<short-description>`, `chore/<short-description>`, `docs/<short-description>`.

## Pull request requirement

- Every change reaches `main` through a pull request. No exceptions — including docs, config, and one-line fixes.
- Fill out the PR template completely, including the risk and impact sections.

## Required tests before PR

- New or changed behavior must ship with tests in the same PR (see [TESTING.md](TESTING.md) for required categories).
- Changes touching tenancy, inventory, pricing, or payments must include the corresponding invariant tests (tenant isolation, ledger, pricing audit, payment flow).
- Run locally before opening the PR: `pnpm run lint`, `pnpm run typecheck`, `pnpm run test`, `pnpm run build`.

## CI must pass

- All GitHub Actions checks (`ci.yml` and `secrets.yml`) must be green before a PR is eligible for review or merge.
- Do not merge on red or bypass checks.

## Codex review required

- Codex reviews every PR as lead reviewer, tester, refactorer, and release-quality checker.
- Codex review comments marked blocking must be resolved before merge.
- Use the "Notes for Codex review" section of the PR template to point the review at risk areas.

## Human approval required

- At least one human approval is required on every PR before merge, in addition to Codex review.
- Agents may open, update, and iterate on PRs, but a human makes the final merge decision.
