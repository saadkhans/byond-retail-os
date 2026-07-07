---
description: Fetch active Codex PR review findings, fix them, verify, commit, push, and request re-review — one cycle, never touching main/dev.
---

# /fix-codex-review — one Codex fix cycle (manual mode)

You are running ONE iteration of the Claude ↔ Codex review loop for this
repository. Follow every step in order. Never skip a guardrail.

Two modes exist; both prioritize latest-review findings:
- **/fix-codex-review (this command)** — exactly one cycle, then stop.
- **/codex-auto-loop** — autonomous multi-cycle mode: repeats fix → verify →
  push → re-review until the latest Codex review is clean or max cycles is
  reached. Merge remains human-only in both modes.

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

## Steps

1. **Find the PR.** `gh pr view --json number,title,url,state` for the
   current branch. If there is no open PR, stop and tell the user.
2. **Fetch findings — latest review first.** ALWAYS start with:
   `pnpm run codex:summary -- --pr <N> --latest-only`
   That is the work list for this cycle. Then run it once more with
   `--latest-only --include-previous-active` so older still-active threads
   are visible for verification (never for automatic re-fixing). Each
   finding is tagged `[latest-review]`, `[previous-review-active]`,
   `[outdated]`, or `[resolved]`, with its review commit SHA and creation
   time.
3. **Triage — recency first, then priority:**
   - **`latest-review` findings are the primary work of this cycle.** These
     came from Codex reviewing the current (or near-current) head. Within
     them: P0/P1/P2 are blocking (P0 highest); P3 fix-if-cheap or defer
     with a reason.
   - **`previous-review-active` findings are suspect-stale.** They are from
     older reviews and often already fixed. NEVER re-fix one without first
     verifying it still exists in the current code (its review commit SHA
     tells you what Codex was looking at). If already fixed, list it in the
     report/PR comment as stale for Codex to mark outdated — do NOT resolve
     the GitHub thread yourself.
   - Ignore `[outdated]`/`[resolved]` findings unless the user says
     otherwise.
4. **Read before changing.** Read AGENTS.md, SECURITY.md, TESTING.md, and
   every file a finding touches. Verify each finding is still present in the
   current code — Codex sometimes reviews a stale snapshot. If a finding is
   already fixed, note it as such; do not re-fix.
5. **Fix.** Smallest correct change per finding. Add or update tests proving
   each fix, per TESTING.md.
6. **Verify.** From the repo root run, in order:
   `pnpm run lint` · `pnpm run typecheck` · `pnpm run test` · `pnpm run build`.
   Fix all failures. If a failure is unrelated to your changes and you cannot
   fix it safely, STOP and report instead of pushing.
7. **Commit.** One commit on the current branch, message style:
   `fix(api): address Codex review — <short summary>` with a body listing
   each finding and its resolution.
8. **Push.** `git push` to the SAME branch only.
9. **Request re-review.** Comment on the PR:
   `gh pr comment <N> --body "@codex review — pushed fixes for the active findings: <one line per finding>. P3 deferrals (if any) listed below."`
10. **Stop.** Produce a final report: findings fixed, tests added, commands
    run with results, deferred P3s with reasons, and anything escalated.
    Do NOT start another cycle even if new comments appear.

## When to escalate instead of proceeding

- CI is red for reasons unrelated to the findings.
- A finding conflicts with AGENTS.md/ARCHITECTURE.md invariants.
- A finding requires a product decision (scope, UX, data model).
- You and Codex disagree about whether something is a real defect.

In all of these: explain in the report, take no irreversible action, and let
the human decide. The merge is always human-approved.
