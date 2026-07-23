# The Claude ↔ Codex PR Review Loop

A safe, human-supervised workflow where Claude Code builds and fixes,
Codex reviews, and a human always makes the final merge decision.

## Orchestrator-worker architecture

Inside a `/fix-codex-review` or `/codex-auto-loop` session, the main Claude
instance is the **orchestrator**: it plans the cycle, decides which findings
are MVP-blocking, reviews worker output, runs the final gate, and performs
commit / push / PR comments. Routine work is delegated to lightweight
subagents defined in `.claude/agents/`:

| Agent | Role | Model | Edits files? |
| --- | --- | --- | --- |
| `codex-review-reader` | Fetch + distill latest active Codex findings (P0–P3) | haiku | no |
| `repo-investigator` | Map a finding to exact files/functions/DTOs/migrations/tests; minimal plan | sonnet | no |
| `fix-worker` | Apply narrow, explicitly-planned code fixes; preserve tenant isolation, RBAC, audit, tests | sonnet | yes |
| `docs-worker` | Fix README/Swagger/PR-description/API-doc mismatches; never runtime logic | sonnet | yes |
| `test-runner` | Run lint · typecheck · test · build · security:secrets · ml:test; summarize failures | haiku | no |
| `secret-scan-worker` | Diagnose Gitleaks hits (current files vs branch history); recommend clean squash for history-only false positives | inherit | no* |
| `ml-pipeline-reviewer` | PASS/BLOCK review of `ml/` pipeline changes for MVP safety | inherit | no |
| `dataset-safety-worker` | SAFE/UNSAFE scan of the diff and `.gitignore` for datasets/media/model weights/training outputs | sonnet | no |
| `vision-event-contract-worker` | COMPATIBLE/INCOMPATIBLE check that ML output examples and the mapper match the Phase 7 VisionEvent ingest contract | sonnet | no |
| `final-reviewer` | Pre-push PASS/BLOCK gate: tenant isolation, RBAC/module gating, audit, data-loss, migration safety, secret/payment safety, MVP scope | inherit | no |

\* `secret-scan-worker` only performs a history rewrite (soft-reset squash +
`--force-with-lease`) when the orchestrator explicitly instructs it; by
default it recommends. It never suppresses real secrets and never bypasses
scanning.

Delegation rules:

- The orchestrator does a worker's job inline only when the worker has
  failed the same task twice, or the task is safety-critical (real secrets,
  destructive git operations, invariant conflicts).
- Workers never commit, push, comment on the PR, or resolve review
  threads — those belong to the orchestrator (and the merge to the human).
- Independent worker tasks (e.g. investigating several findings) run in
  parallel.
- New/changed agent files load at session start — restart the Claude Code
  session after editing `.claude/agents/`.

## Two modes

| Mode | Command | Behavior |
| --- | --- | --- |
| **Manual** (one cycle) | `/fix-codex-review` | One fetch → fix → verify → push → re-review cycle, then stop |
| **Auto-loop** (multi-cycle) | `/codex-auto-loop --pr <N> --max-cycles 5` | Repeats cycles until the latest Codex review is clean (`READY_FOR_HUMAN_MERGE`) or max cycles is reached |

Both modes prioritize `latest-review` findings, verify
`previous-review-active` findings before touching them, and leave the merge
to a human. The auto-loop uses a deterministic helper,
`pnpm run codex:auto-loop -- --pr <N>`, which checks guardrails, fetches
findings into `.tmp/codex-latest-findings.md`, and prints a STATUS line —
the helper itself never edits code, pushes, comments, or merges.

```bash
# Orchestration helper (used by /codex-auto-loop; safe to run standalone)
pnpm run codex:auto-loop -- --pr 2                 # status + findings file
pnpm run codex:auto-loop -- --pr 2 --dry-run       # status only, writes nothing
pnpm run codex:auto-loop -- --pr 2 --max-cycles 5  # echoed into loop budget
pnpm run codex:auto-loop -- --pr 2 --no-push       # stop before push/comment
# ML PR: READY_FOR_HUMAN_MERGE additionally requires the attestation file
# .tmp/codex-ml-gates-pr-<PR>-<HEAD_SHA>.json, written by the orchestrator
# only after all four ML safety gates pass on the current head.
```

STATUS meanings:
- `READY_FOR_HUMAN_MERGE` — Codex is clean on the current head AND the
  helper verified, fresh from GitHub immediately before the decision, that
  the local HEAD equals the PR head, every GitHub check (CI, secret
  scanning, ...) reports success, and the PR is mergeable. READY therefore
  means: Codex clean + (ML PR ⇒ valid attestation AND local HEAD == PR
  head) + CI success + secret scanning success + mergeable. The human
  reviews the PR and merges manually. Nothing ever merges automatically.
  For ML PRs this status only appears when a valid ML-gates attestation
  file exists for the current head (see `ML_SAFETY_GATES_REQUIRED` below).
  Clean-verdict comments count only from the exact Codex bot login
  (`chatgpt-codex-connector` / `chatgpt-codex-connector[bot]`, the shared
  exact allowlist in `scripts/codex-bot-logins.mjs` — no substring
  matching), and the newest Codex verdict always wins: a formal
  review that is newer than a clean comment on the same head supersedes it,
  so an older clean comment can never override newer active findings.
- `ML_SAFETY_GATES_REQUIRED` — Codex findings are clean (clean-verdict
  comment or zero latest findings) on an ML PR, but no valid ML safety-gate
  attestation exists for the current head. Run the four gates
  (`dataset-safety-worker`, `ml-pipeline-reviewer`,
  `vision-event-contract-worker`, `final-reviewer`) against the current
  head; any failed gate is treated as `CLAUDE_FIX_REQUIRED`. Only once all
  four return SAFE/PASS/COMPATIBLE/PASS, write
  `.tmp/codex-ml-gates-pr-<PR>-<HEAD_SHA>.json` (the helper prints the
  exact path and a filled-in example) with
  `{ "pr": <number>, "headSha": "<full sha>", "createdAt": "<ISO>",
  "gates": { <each gate>: "PASS" } }` — each gate recorded as the exact
  string `"PASS"` — and re-run the helper to receive
  `READY_FOR_HUMAN_MERGE`. The helper verifies PR number, exact head SHA,
  timestamp, and all four gates; an attestation for a different head SHA
  is stale and ignored (re-run the gates after every push).
- `CLAUDE_FIX_REQUIRED (n)` — findings saved for Claude Code to fix inside
  a `/codex-auto-loop` or `/fix-codex-review` session.
- `WAITING_FOR_CODEX_REVIEW` — the latest Codex review predates the PR
  head (or no Codex review exists yet), so any reported findings belong to
  an older commit. Nothing is written; wait for Codex to re-review, then
  re-run. This is what a re-run prints in the window right after a fix
  cycle pushes.
- `LOCAL_HEAD_MISMATCH` — the local checkout's HEAD is not the PR head
  (`headRefOid`). Safety gates and ML attestations inspect the local
  checkout, so they must only run — and an attestation must only be
  written — while local HEAD equals the PR head. Sync your local branch to
  the PR head before running gates (`git fetch origin` + fast-forward
  pull, or push local commits so the PR head advances); the helper never
  resets the branch automatically and makes no other status decision.
- `PR_NOT_MERGEABLE` — GitHub reports merge conflicts
  (`mergeable: CONFLICTING`). Resolve the conflicts on the feature branch
  and push before the PR can be handed to human merge.
- `GITHUB_CHECKS_FAILED` — one or more GitHub checks (CI, secret
  scanning, ...) failed on the PR head; the helper lists the failing
  checks. Fix and push — never bypass a failing check.
- `GITHUB_CHECKS_REQUIRED` — GitHub checks are pending or not reporting on
  the PR head, or GitHub is still computing mergeability
  (`mergeable: UNKNOWN`). Absence of checks is never treated as success;
  wait for them to complete and re-run shortly.

Note on clean re-reviews: when Codex finds nothing, it does NOT submit a
formal review — it posts a "Didn't find any major issues" PR comment naming
the reviewed commit. The helper accepts such a comment on the current head
as a clean verdict (`READY_FOR_HUMAN_MERGE`) only if (a) the comment author
login is exactly `chatgpt-codex-connector` or
`chatgpt-codex-connector[bot]` — lookalike logins that merely contain
"codex" are ignored — and (b) no newer formal Codex review covers the same
head (the newest verdict wins; if timestamps cannot be compared, the formal
review wins). Threads left over from older reviews then need manual
resolution, since no re-review ran to mark them outdated.

The helper also refuses to run on a dirty working tree (it would otherwise
instruct a fix cycle that commits unrelated edits); pass `--allow-dirty`
only when the uncommitted changes were made by the current loop session.

## The loop

| Step | Who | What |
| --- | --- | --- |
| A | Developer | Create a feature branch (`feat/…`, `fix/…`) from `dev` |
| B | Claude | Build the feature (per AGENTS.md scope rules) |
| C | Developer | Review the diff, run checks locally |
| D | Developer | Commit, push the branch, open the PR |
| E | Codex | Reviews the PR, leaves prioritized findings (P1/P2/P3) |
| F | Developer | `pnpm run codex:summary` — see the active findings |
| G | Developer | Invoke the Claude command: `/fix-codex-review` |
| H | Claude (orchestrator → workers) | Fixes **only** the Codex findings — reader → investigator → fix/docs workers |
| I | Claude (test-runner) | Runs `pnpm run lint`, `typecheck`, `test`, `build`, `security:secrets`, `ml:test` — all must pass |
| I' | Claude (final-reviewer) | PASS/BLOCK gate on the full diff before anything is pushed |
| J | Claude (orchestrator) | Commits and pushes to the **same** branch |
| K | Claude (orchestrator) | Comments `@codex review` on the PR to request re-review |
| L | Both | Repeat E–K until Codex has no blocking issues |
| M | **Human** | Reviews and merges. Always. |

Each `/fix-codex-review` invocation performs **exactly one** fix cycle and
stops — the loop advances only when a human re-invokes it.

## Phase 8 ML-aware review

When the PR diff changes any path under `ml/` or one of the ML agent files
(`.claude/agents/ml-pipeline-reviewer.md`,
`.claude/agents/dataset-safety-worker.md`,
`.claude/agents/vision-event-contract-worker.md`), `.gitignore`, or any
file with a blocked artifact extension (weights/media/data blobs) anywhere
in the repo — with branch/title
keywords (`phase8`, `ml`, `training`, `dataset`, `cv-training`,
word-boundary match) as a fallback when the changed-file list cannot be
fetched — the loop runs `ml-pipeline-reviewer`, `dataset-safety-worker`,
and `vision-event-contract-worker` before `final-reviewer` (step I').
These gates gate ANY `READY_FOR_HUMAN_MERGE` declaration: when Codex
findings are clean on an ML PR (including zero latest findings), the
helper reports `ML_SAFETY_GATES_REQUIRED` instead of
`READY_FOR_HUMAN_MERGE`, and the orchestrator must run all four gates
against the current head. An UNSAFE/BLOCK/INCOMPATIBLE verdict re-enters
the fix pipeline as if the status were `CLAUDE_FIX_REQUIRED`; only once
all four gates return SAFE/PASS/COMPATIBLE/PASS does the orchestrator
write the attestation file `.tmp/codex-ml-gates-pr-<PR>-<HEAD_SHA>.json`
(each gate recorded as `"PASS"`) and re-run the helper — a verified
attestation for the exact current head is the only way
`READY_FOR_HUMAN_MERGE` is reported for an ML PR, and any new push makes
the previous attestation stale. `ml/` is a stdlib-only Python workspace
outside the pnpm workspace; datasets and model weights are external
artifacts and must never be committed.

Merge-blockers specific to Phase 8:
1. Datasets/images/videos committed to the repo
2. Model weights committed to the repo
3. Heavy ML dependencies required by normal CI
4. Generated training outputs committed
5. VisionEvent payload incompatible with the Phase 7 ingest contract
6. Reintroduction of evidence artifacts/metadata/URIs/storageKeys into app ingestion
7. Secret scanning failure
8. Failing CI/build/tests

## Commands

```bash
# Summarize Codex findings for the current branch's PR
pnpm run codex:summary

# Explicit PR number
pnpm run codex:summary -- --pr 2

# Only findings from the LATEST Codex review (the low-noise fix-cycle view)
pnpm run codex:summary -- --pr 2 --latest-only

# Latest-only, but also show older still-active threads for verification
pnpm run codex:summary -- --pr 2 --latest-only --include-previous-active

# Reminder of the Claude command
pnpm run codex:fix-loop:docs

# Run the Phase 8 ML pipeline's stdlib-only Python tests
pnpm run ml:test
```

### Finding states

Every finding is tagged with a state, its review commit SHA, and creation
time, so stale threads stop generating repeated noise:

| State | Meaning | What to do |
| --- | --- | --- |
| `latest-review` | Active, from the most recent Codex review | Fix this cycle (P0/P1/P2 blocking, P0 highest; P3 fix-or-defer) |
| `previous-review-active` | Active on GitHub, but from an older review | **Verify against current code first** — often already fixed; report as stale rather than re-fixing |
| `outdated` | GitHub marked the thread outdated (code moved) | Ignore |
| `resolved` | Thread resolved on GitHub | Ignore |

The default output orders sections: Latest Review Findings → Previous
Active Findings → Outdated/ignored. Neither the script nor Claude ever
resolves GitHub threads — Codex marks its own threads outdated on
re-review, and humans may resolve manually.

Then, inside a Claude Code session on the feature branch:

```
/fix-codex-review
```

## Guardrails

- **Never auto-merge.** Merging is a human action, gated by branch
  protection (required review + green CI) on `main` and `dev`.
- **Never push to `main`/`dev`.** The command refuses to run on those
  branches; all pushes go to the current feature branch only.
- **Max one fix cycle per invocation.** No unattended loops.
- **Clean tree required.** A dirty working tree stops the command before it
  starts.
- **P0/P1/P2 findings are blocking** (P0 is the highest severity) — they
  must be fixed before requesting re-review. **P3 may be fixed or explicitly
  deferred** with a reason in the PR comment.
- **Security findings are never waived casually.** Disagreement with a
  security finding is an escalation to the human, not a skip.
- **If CI fails, stop.** Fix CI before asking Codex to re-review — never
  burn review cycles on a red build.
- **If Codex and Claude disagree,** the human decides. Claude documents the
  disagreement in the PR instead of acting on its own judgment.
- **Scope discipline:** only Codex findings are fixed in a cycle. New
  features, refactors, and cleanups belong in their own branches.

## Suggested PR labels (optional)

These labels are useful for tracking loop state at a glance. They are not
required and do not need to exist yet:

| Label | Meaning |
| --- | --- |
| `codex-reviewed` | Codex has completed at least one review pass |
| `needs-claude-fix` | Active Codex findings await a fix cycle |
| `claude-fix-pushed` | Claude pushed fixes; awaiting Codex re-review |
| `ready-for-human-merge` | No blocking findings; human review is next |
| `security-blocker` | A security finding blocks merge until resolved |

## What the human still does

Even in auto-loop mode, a human: opens the PR, decides when to invoke the
loop, answers escalations (product decisions, invariant conflicts,
Claude/Codex disagreements), reviews the final diff, resolves any manually
verified stale threads, and **clicks merge**. Branch protection (required
review + green CI) enforces the last step regardless of tooling.

## Troubleshooting

- **`/codex-auto-loop` or `/fix-codex-review` says "Unknown command"** —
  Claude Code loads `.claude/commands/` at session start. Restart the
  session (or run `/reload-skills` if available). The files must be
  committed/present in the repo you opened.
- **"GitHub CLI is not authenticated"** — run `gh auth login` (device flow
  works fine). Verify with `gh auth status`. The tooling uses your personal
  gh auth; no tokens live in the repo.
- **Codex does not respond to `@codex review`** — Codex reviews take a few
  minutes; the loop stops rather than busy-waiting. Re-run
  `/codex-auto-loop` after the review lands. If Codex never responds,
  check that the ChatGPT/Codex GitHub app is installed on the repo with
  code review enabled, then re-request from the PR page.
- **`security:secrets` reports UNAVAILABLE (exit 2)** — gitleaks is not
  installed locally. Install it
  (https://github.com/gitleaks/gitleaks) to scan locally, or rely on the
  GitHub secret-scanning check — but never report UNAVAILABLE as a pass.
  Exit 1 means gitleaks found real leaks: route to `secret-scan-worker`.
- **Stale findings keep reappearing** — threads from older reviews stay
  "active" on GitHub until Codex marks them outdated on re-review or a
  human resolves them. They are classified `previous-review-active` and
  are never auto-fixed; ask Codex to re-review or resolve them manually.

## Prerequisites & setup

1. **GitHub CLI** installed and authenticated: `gh auth login`.
   The summary script uses your existing `gh` auth — no tokens live in the
   repository.
2. **Codex connected to the repo** (the ChatGPT/Codex GitHub app with code
   review enabled) so review comments exist to fetch.
3. Node 22 + pnpm via corepack (already required by this repo).
4. **gitleaks** (recommended) for the local secret scan.
   `pnpm run security:secrets` runs a real `gitleaks detect` when gitleaks
   is installed (exit 0 = clean, exit 1 = leaks found). When gitleaks is
   not installed it exits 2 (`UNAVAILABLE`) — that is NOT a pass; the
   GitHub secret-scanning check remains the authoritative gate.

## How the summary script works & limitations

`scripts/codex-review-summary.mjs` queries the GitHub GraphQL
`reviewThreads` API through `gh api graphql` and:

- keeps only threads whose **first comment author login is exactly one of
  the allowlisted Codex bot logins** (`chatgpt-codex-connector` /
  `chatgpt-codex-connector[bot]`, shared with the auto-loop helper via
  `scripts/codex-bot-logins.mjs`) — never substring matching, so a
  lookalike login cannot inject findings or become the "latest Codex
  review";
- treats threads that are **unresolved and not outdated** as active, and
  groups them by `P1`/`P2`/`P3` markers found in the comment body
  (unmarked findings land in an "Unprioritized" bucket);
- lists resolved/outdated threads separately so nothing is silently lost —
  every entry links back to its source comment for verification;
- covers the first 100 review threads (a warning is printed if more exist);
- reads only — it never writes to the PR.

Priorities are parsed from Codex's own comment text; if Codex changes its
format, unmarked findings still appear (as Unprioritized) rather than being
dropped.
