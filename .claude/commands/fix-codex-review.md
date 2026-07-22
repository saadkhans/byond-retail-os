---
description: Fetch active Codex PR review findings, delegate investigation and fixes to subagents, verify, commit, push, and request re-review — one cycle, never touching main/dev.
---

# /fix-codex-review — one Codex fix cycle (manual, orchestrator mode)

You are running ONE iteration of the Claude ↔ Codex review loop for this
repository, acting as the ORCHESTRATOR. Follow every step in order. Never
skip a guardrail.

Two modes exist; both prioritize latest-review findings:
- **/fix-codex-review (this command)** — exactly one cycle, then stop.
- **/codex-auto-loop** — autonomous multi-cycle mode.
Merge remains human-only in both modes.

## Orchestrator role

Delegate routine work to the subagents in `.claude/agents/` (Agent tool);
do it inline only if a worker fails the same task twice or the task is
safety-critical (secrets, destructive git operations, invariant conflicts):

- `codex-review-reader` — fetch + distill the latest active findings
- `repo-investigator` — map each finding to files/tests; minimal plan
- `fix-worker` — apply narrow code fixes from an explicit plan
- `docs-worker` — docs-only findings (README, Swagger, PR description)
- `test-runner` — lint · typecheck · test · build · security:secrets
- `secret-scan-worker` — diagnose Gitleaks failures, recommend remediation
- `dataset-safety-worker` — scan diff/.gitignore for datasets, media, model weights, training outputs
- `ml-pipeline-reviewer` — Phase 8 ML pipeline MVP-safety review (PASS/BLOCK)
- `vision-event-contract-worker` — verify ML output matches the Phase 7 VisionEvent contract
- `final-reviewer` — pre-push PASS/BLOCK on the full diff

You keep for yourself: MVP-blocking triage, plan review, commit, push, PR
comments, and every escalation. Workers never commit, push, or comment.

## Guardrails (hard rules — check before any other work)

1. Run `git branch --show-current`. If the branch is `main` or `dev`, STOP
   immediately and tell the user this command only runs on feature branches.
2. Run `git status --porcelain`. If the working tree is dirty, STOP and ask
   the user whether to commit, stash, or abort. Never start with a dirty tree.
3. Never merge anything. Never push to any branch other than the current one.
4. Perform exactly ONE fix cycle, then stop and report. Do not loop.
5. Fix ONLY Codex findings. No unrelated product features, refactors, or
   drive-by cleanups. (AGENTS.md scope rules apply on top.)
6. Security-relevant findings must be fixed, not waived. If a finding seems
   wrong or out of scope, say so in the report and escalate to the user —
   do not silently skip it.
7. Never resolve GitHub review threads yourself — Codex marks its own
   threads resolved/outdated on re-review; humans may resolve manually.
8. Never bypass GitHub checks or secret scanning.

## Steps

1. **Find the PR.** `gh pr view --json number,title,url,state` for the
   current branch. If there is no open PR, stop and tell the user.
2. **Fetch findings.** Spawn `codex-review-reader` for PR <N>. It runs
   `pnpm run codex:summary -- --pr <N> --latest-only` (and
   `--include-previous-active` for the stale list) and returns the grouped
   work list. If it reports the latest review predates the PR head, STOP —
   the findings are stale; wait for Codex.
3. **Triage (your decision, not a worker's) — recency first, then priority:**
   - `latest-review` findings are the work of this cycle: P0/P1/P2 blocking
     (P0 highest); P3 fix-if-cheap or defer with a reason.
   - `previous-review-active` findings are suspect-stale. NEVER re-fix one
     without verifying it still exists in current code; if already fixed,
     list it as stale in the report/PR comment — do NOT resolve the thread.
   - Ignore `[outdated]`/`[resolved]` findings unless the user says
     otherwise.
   - Split blocking findings into code findings and docs-only findings.
4. **Investigate.** Read AGENTS.md, SECURITY.md, TESTING.md yourself. Spawn
   one `repo-investigator` per code finding (parallel). Each verifies the
   finding against current code and returns a minimal plan. ALREADY FIXED →
   report as stale; ESCALATE → take it to the user.
5. **Fix.** Review each plan for scope and invariants; hand approved plans
   to `fix-worker` (docs-only findings to `docs-worker`). Smallest correct
   change per finding, with tests per TESTING.md. A worker that fails twice
   on the same finding → do that fix yourself.
6. **Verify.** Spawn `test-runner`:
   `pnpm run lint` · `pnpm run typecheck` · `pnpm run test` ·
   `pnpm run build` · `pnpm run security:secrets` · `pnpm run ml:test`.
   Route failures caused by this cycle's changes back to the responsible
   worker. `security:secrets` failures → `secret-scan-worker`
   (REAL_SECRET_FOUND = immediate stop + escalate). If a failure is
   unrelated and cannot be fixed safely, STOP and report instead of pushing.
6a. **ML-aware review.** Trigger: the PR's changed files (via
   `gh pr view <n> --json files` or `git diff origin/dev...HEAD --name-only`)
   touch `ml/**` or one of the ML agent files
   (`.claude/agents/ml-pipeline-reviewer.md`,
   `.claude/agents/dataset-safety-worker.md`,
   `.claude/agents/vision-event-contract-worker.md`) — this is the primary
   signal. If the file lookup fails, fall back to branch/title keywords
   (`phase8`, `ml`, `training`, `dataset`, `cv-training`, word-boundary
   match — `ml` must not fire on `html`/`yaml`). When triggered, spawn
   `dataset-safety-worker`, `ml-pipeline-reviewer`, and
   `vision-event-contract-worker` before `final-reviewer`; their
   BLOCK/UNSAFE/INCOMPATIBLE verdicts are merge blockers.
7. **Final review.** Spawn `final-reviewer` on the full diff. BLOCK →
   resolve the blockers (back through steps 4–6) and re-review; never push
   a BLOCKed diff.
8. **Commit** (yourself). One commit on the current branch, message style:
   `fix(api): address Codex review — <short summary>` with a body listing
   each finding and its resolution.
9. **Push** (yourself). `git push` to the SAME branch only.
10. **Request re-review.** Comment on the PR:
    `gh pr comment <N> --body "@codex review — pushed fixes for the active findings: <one line per finding>. P3 deferrals (if any) listed below."`
11. **Stop.** Produce a final report: findings fixed (and which worker
    handled each), tests added, check results, final-reviewer verdict,
    deferred P3s with reasons, and anything escalated. Do NOT start another
    cycle even if new comments appear.

## When to escalate instead of proceeding

- CI is red for reasons unrelated to the findings.
- A finding conflicts with AGENTS.md/ARCHITECTURE.md invariants.
- A finding requires a product decision (scope, UX, data model).
- You and Codex disagree about whether something is a real defect.
- secret-scan-worker reports a real secret.

In all of these: explain in the report, take no irreversible action, and let
the human decide. The merge is always human-approved.
