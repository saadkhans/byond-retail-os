---
description: Autonomous multi-cycle Codex review-fix loop — orchestrator delegates fetch/investigate/fix/verify to subagents, then commits, pushes, and requests re-review; repeat until clean or max cycles. Merge stays human-only.
---

# /codex-auto-loop — autonomous Codex fix loop (orchestrator mode)

Arguments: `$ARGUMENTS` (e.g. `--pr 2 --max-cycles 5`). Defaults: PR
auto-detected from the current branch, max cycles 3.

You are running the AUTONOMOUS multi-cycle mode of the Claude ↔ Codex loop
as the ORCHESTRATOR. `/fix-codex-review` is the one-cycle manual variant.
The final merge is ALWAYS a human action — this command must never merge.

## Orchestrator role (read first)

You plan, decide, review, and ship. Routine work is DELEGATED to the
subagents in `.claude/agents/` via the Agent tool — you do not do it
yourself. Do a worker's job inline only when (a) that worker has failed the
same task twice, or (b) the task is safety-critical (secret handling,
destructive git operations, invariant conflicts) and you must see it
first-hand. Launch independent worker tasks in parallel where possible
(e.g. investigating several findings at once).

| Worker | Delegated work |
| --- | --- |
| `codex-review-reader` | Fetch + distill latest active Codex findings |
| `repo-investigator` | Map each finding to files/functions/DTOs/migrations/tests; minimal plan |
| `fix-worker` | Apply narrow code fixes from an explicit plan |
| `docs-worker` | Docs-only findings (README, Swagger, PR description, API docs) |
| `test-runner` | lint · typecheck · test · build · security:secrets, failure summary |
| `secret-scan-worker` | Diagnose Gitleaks failures; recommend clean-squash remediation |
| `dataset-safety-worker` | Scan diff/.gitignore for datasets, media, model weights, training outputs |
| `ml-pipeline-reviewer` | Phase 8 ML pipeline MVP-safety review (PASS/BLOCK) |
| `vision-event-contract-worker` | Verify ML output matches the Phase 7 VisionEvent contract |
| `final-reviewer` | Pre-push PASS/BLOCK review of the full diff |

Reserved for the orchestrator (never delegated): deciding which findings
are MVP-blocking, resolving worker disagreements, git commit, git push,
PR comments (`@codex review`), and all escalations to the user.

## Before the first cycle

1. Read AGENTS.md, SECURITY.md, TESTING.md, and
   docs/development/codex-claude-loop.md.
2. Run `git branch --show-current`. STOP immediately on `main` or `dev`.
3. Run `git status --porcelain`. If dirty with changes NOT made by this
   loop, STOP and ask the user (commit/stash/abort). Changes this loop made
   in an earlier cycle of the same session are fine.
4. Resolve the PR: `gh pr view --json number,state,headRefName` (or use
   `--pr` from the arguments). The PR must be OPEN and its head branch must
   equal the current branch. STOP otherwise.
5. If `gh` is missing or unauthenticated, STOP and tell the user to run
   `gh auth login`.

## Each cycle (repeat up to max-cycles)

a. Run `pnpm run codex:auto-loop -- --pr <N>` (append `--no-push` or
   `--wait-seconds` if the user passed them). It re-checks guardrails,
   fetches findings, and prints a STATUS line.
b. **STATUS: READY_FOR_HUMAN_MERGE** → stop the loop and report: the PR has
   no active latest-review findings; the human reviews and merges manually.
   (A clean Codex re-review arrives as a "didn't find any major issues" PR
   comment, not a formal review — the helper detects that too.)
   **ML PRs (per the ML-aware trigger below):** the loop is NOT done yet —
   before declaring ready-for-merge, spawn `dataset-safety-worker`,
   `ml-pipeline-reviewer`, and `vision-event-contract-worker`, then
   `final-reviewer`, and require all four to run clean. These gates run
   even when Codex reports zero findings; any UNSAFE/BLOCK/INCOMPATIBLE
   verdict re-enters the fix pipeline as if the status were
   CLAUDE_FIX_REQUIRED.
b'. **STATUS: WAITING_FOR_CODEX_REVIEW** → the latest Codex review predates
   the PR head; any reported findings are stale. STOP and tell the user to
   re-run `/codex-auto-loop` after Codex replies — never re-fix them.
c. **STATUS: CLAUDE_FIX_REQUIRED** → run the delegation pipeline:
   1. **Read** — spawn `codex-review-reader` for PR <N> (it reads
      `.tmp/codex-latest-findings.md` and the live summary) and take its
      grouped P0/P1/P2/P3 list as the cycle work list.
   2. **Triage (orchestrator decision)** — decide which findings are
      MVP-blocking for the current phase: P0/P1/P2 are blocking and must be
      fixed; P3 fix-if-cheap or defer with a written reason;
      `previous-review-active` findings are untouchable unless verified to
      still reproduce. Split the blocking list into code findings and
      docs-only findings.
   3. **Investigate** — spawn one `repo-investigator` per code finding (in
      parallel). Each returns exact locations and a minimal plan. A finding
      it marks ALREADY FIXED is reported, not re-fixed; ESCALATE findings
      go to the user.
   4. **Fix** — review each plan; if sound, hand it verbatim to
      `fix-worker` (one worker per finding or small coherent batch —
      parallel only when the findings touch disjoint files). Docs-only
      findings go to `docs-worker` instead.
   5. **Verify** — spawn `test-runner` for the full suite: lint ·
      typecheck · test · build · security:secrets · ml:test.
   6. **Repair** — failures caused by this cycle's changes go back to the
      responsible `fix-worker` with the failure summary (max 2 attempts per
      worker per finding, then do it yourself). If `security:secrets`
      fails, spawn `secret-scan-worker`; act on its recommendation — a
      history clean-squash needs your explicit go-ahead, a REAL_SECRET
      verdict is an immediate STOP + escalation to the user. Unrelated
      failures that cannot be fixed safely: STOP and report — never push a
      red build.
   7. **Final review** — spawn `final-reviewer` on the full diff. BLOCK →
      route blockers back through steps 3–6 (or fix inline if
      safety-critical), then re-review. Never push a BLOCKed diff.
d. Commit on the current branch (orchestrator, not a worker):
   `fix: address latest Codex review findings`
   with each finding and its resolution listed in the body.
e. Push to the CURRENT branch only. (Skip push/comment if `--no-push`.)
f. Comment on the PR:
   `@codex review the latest changes and confirm whether all previous findings are resolved.`
g. Codex re-reviews asynchronously (typically a few minutes). Re-run step
   (a) once; if the latest Codex review still predates your push, STOP and
   tell the user to re-run `/codex-auto-loop` after Codex replies — do not
   busy-wait or burn cycles polling.

### ML-aware review (Phase 8)

Trigger: if the PR diff changes any path under `ml/` or one of the ML agent
files (`.claude/agents/ml-pipeline-reviewer.md`,
`.claude/agents/dataset-safety-worker.md`,
`.claude/agents/vision-event-contract-worker.md`) — with branch/title
keywords (`phase8`, `ml`, `training`, `dataset`, `cv-training`;
word-boundary match — `ml` must not fire on `html`/`yaml`) as a fallback
when the changed-file list cannot be fetched — spawn
`dataset-safety-worker`, `ml-pipeline-reviewer`, and
`vision-event-contract-worker` before `final-reviewer` in the pre-push
step. These gates also run before ANY ready-for-merge declaration, even
when Codex reports zero findings (see step b).

Phase 8 merge blockers (any one blocks push/merge): (1) datasets/images/videos
committed; (2) model weights committed; (3) heavy ML dependencies required by
normal CI; (4) generated training outputs committed; (5) VisionEvent payload
incompatible with Phase 7; (6) reintroduction of evidence
artifacts/metadata/URIs/storageKeys into app ingestion; (7) secret scanning
failure; (8) failing CI/build/tests.

## Loop exit criteria

The loop is DONE only when all of these hold (otherwise repeat or stop per
the rules above): CI checks pass, secret scanning passes, Codex has no
active latest-review findings, and the PR is mergeable
(`gh pr view --json mergeable,mergeStateStatus`). Then report
READY_FOR_HUMAN_MERGE — the human merges.

## Stop conditions (any of these ends the loop immediately)

- READY_FOR_HUMAN_MERGE.
- Max cycles reached (report how many findings remain).
- Checks fail for reasons this cycle cannot safely fix.
- secret-scan-worker reports REAL_SECRET_FOUND.
- A finding requires a product decision (scope, UX, data model) or
  conflicts with AGENTS.md/ARCHITECTURE.md invariants → escalate to the
  user with your analysis.
- You disagree with Codex about whether a finding is a real defect →
  escalate; never silently skip a security finding.
- Working tree contains changes you (or your workers) did not make.

## Hard rules (never violate, in any cycle)

- Never merge. Never enable auto-merge. The human merges.
- Never push to `main` or `dev`; never run on them.
- Never bypass GitHub checks, secret scanning, or branch protection.
- Never resolve GitHub review threads — Codex marks its own threads
  outdated on re-review; humans may resolve manually.
- Ignore outdated Codex comments unless the latest summary still lists them;
  never fix `previous-review-active` findings that don't reproduce.
- Do not overbuild: no non-MVP hardening unless it blocks the current phase.
- Workers never commit, push, or comment — only the orchestrator does.
- One commit per cycle, on the current feature branch.

## Final report (always, whatever ended the loop)

Cycles run, findings fixed per cycle (with commits and which worker handled
each), tests added, check results, deferred P3s with reasons, final-reviewer
verdicts, anything escalated, and the loop's end state
(READY_FOR_HUMAN_MERGE / awaiting Codex / max cycles / escalation).
