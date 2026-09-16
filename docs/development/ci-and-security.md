# CI and security scanning

## Workflows

| Workflow | Job | Gates merges |
| --- | --- | --- |
| `ci.yml` | `Lint, typecheck, test, build` | Yes — branch protection matches this name |
| `ci.yml` | `Integration (Postgres)` | Not yet required; see below |
| `secrets.yml` | `Gitleaks` | Yes |
| `security.yml` | `Semgrep and Trivy` | Not yet required |
| `security.yml` | `Container image scan` | Not yet required |

The repeated setup — Node 22, corepack, a frozen-lockfile install and the
generated Prisma client — lives in the composite action
`infra/github-actions/setup-workspace`, so changing the toolchain is a one-file
change. The scanners live in `infra/github-actions/security-scan`.

The gating job's name is load-bearing: GitHub branch protection matches required
checks by name, so renaming `Lint, typecheck, test, build` would silently make
`main` unprotected. New jobs therefore get new names and are opted into
protection deliberately.

## Running the scanners locally

```bash
pnpm run security:secrets              # Gitleaks over the working tree
pnpm run security:secrets -- --history # ...and the whole git history
pnpm run security:scan                 # Semgrep (ERROR rules) + Trivy
pnpm run security:scan -- --all-severities
```

Both scripts degrade politely: if the scanner is not installed they print how to
install it and exit zero, because a local command that hard-fails on an optional
binary just teaches people to stop running it. Under CI (`CI` set) a missing
scanner is a hard failure instead, since the workflow installs both and absence
there would mean the job is silently scanning nothing.

`infra/semgrep/byond-rules.yml` holds the rules for this repository's own hard
rules: no raw card data in source or logs, no inline secrets, and an advisory
rule for repository reads that do not filter by tenant. Only `ERROR`-severity
rules gate CI — a rule that cries wolf gets disabled, and then it protects
nothing.

## The integration job

`Integration (Postgres)` starts a real Postgres, applies the committed
migrations with `prisma migrate deploy` and seeds the baseline data. Its point
today is the migration chain: the unit suite runs against a stubbed Prisma
client and therefore cannot catch a migration that does not apply to an empty
database, or a schema change that was never written into SQL.

The API tests still run with stubs, so this job does not yet satisfy TESTING.md's
"integration tests with real dependencies" on its own. When repository-level
tests that talk to Postgres land, they belong in this job, and it should then be
added to branch protection.
