# SECURITY.md — Security Requirements

These requirements apply to every service, app, and package in this repository.

## Hard rules

- **Never store raw card data.** No PANs, CVVs, or track data in databases, logs, caches, queues, or error reports. All card handling goes through the payment provider's tokenization; we store tokens and last-4/metadata only.
- **Never commit secrets.** No API keys, credentials, tokens, or private keys in the repo — including in tests, fixtures, docs, and CI files. Use environment variables and a secrets manager. Gitleaks runs on every push and PR.

## Required controls

- **Use RBAC.** Every API endpoint and admin action is gated by role-based access control. Default deny; roles grant the minimum needed.
- **Use tenant isolation.** All tenant-scoped data access is isolated at the data-access layer. Cross-tenant access is a critical severity bug.
- **Use audit logs.** Every state change records who, what, when, and why in an append-only audit log. Audit logs are tenant-scoped and tamper-evident.
- **Use encryption in transit and at rest.** TLS for all network traffic (including edge-to-cloud), encryption at rest for all data stores and backups.
- **Use short-lived QR entry tokens.** Store-entry and session QR tokens are single-use and short-TTL. Never issue long-lived entry credentials.
- **Use least-privilege API keys.** Every integration key is scoped to the minimum permissions and rotated regularly. No shared god-keys.

## Required tools

| Tool | Purpose | Where |
| --- | --- | --- |
| **Gitleaks** | Secret detection | CI (`.github/workflows/secrets.yml`) on every PR and push |
| **Semgrep** | Static analysis / SAST | CI security scan (wired via `security:scan` as code lands) |
| **Trivy** | Container and dependency vulnerability scanning | CI + image builds (`infra/docker/`) |
| **Dependabot** | Dependency update automation | GitHub repository settings |

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner. Do not open a public issue for security problems.
