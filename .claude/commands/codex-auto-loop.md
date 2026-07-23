---
description: Autonomous multi-cycle Codex review-fix loop — fetch, fix, verify, push, request re-review, repeat until clean or max cycles. Merge stays human-only.
---

# /codex-auto-loop — autonomous Codex fix loop

Arguments: `$ARGUMENTS` (e.g. `--pr 2 --max-cycles 5`). Defaults: PR
auto-detected from the current branch, max cycles 3.

You are running the AUTONOMOUS multi-cycle mode of the Claude ↔ Codex loop.
`/fix-codex-review` is the one-cycle manual variant; this command repeats
cycles until the latest Codex review is clean or the cycle budget runs out.
The final merge is ALWAYS a human action — this command must never merge.

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
   comment, not a formal review — the helper detects that too. Threads left
   over from older reviews are then resolved manually by the human.)
b'. **STATUS: WAITING_FOR_CODEX_REVIEW** → the latest Codex review predates
   the PR head; any reported findings are stale. STOP and tell the user to
   re-run `/codex-auto-loop` after Codex replies — never re-fix them.
c. **STATUS: CLAUDE_FIX_REQUIRED** → read `.tmp/codex-latest-findings.md`.
   Fix ONLY the latest-review findings:
   - P0/P1/P2 are blocking and must be fixed (P0 highest). Never ignore one.
   - P3: fix if cheap, otherwise defer with a written reason.
   - `previous-review-active` findings: do NOT fix unless one still
     reproduces in current code or directly overlaps a latest-review fix.
   - Verify every finding against the current code before changing it.
   - Smallest correct change per finding, with tests per TESTING.md.
d. Run, in order: `pnpm run lint` · `pnpm run typecheck` · `pnpm run test`
   · `pnpm run build`.
e. Fix failures caused by this cycle's changes. If a failure is unrelated
   and cannot be fixed safely, STOP and report — do not push a red build.
f. Commit on the current branch:
   `fix: address latest Codex review findings`
   with each finding and its resolution listed in the body.
g. Push to the CURRENT branch only. (Skip push/comment if `--no-push`.)
h. Comment on the PR:
   `@codex review the latest changes and confirm whether all previous findings are resolved.`
i. Codex re-reviews asynchronously (typically a few minutes). Re-run step
   (a) once; if the latest Codex review still predates your push, STOP and
   tell the user to re-run `/codex-auto-loop` after Codex replies — do not
   busy-wait or burn cycles polling.

## Stop conditions (any of these ends the loop immediately)

- READY_FOR_HUMAN_MERGE.
- Max cycles reached (report how many findings remain).
- Checks fail for reasons this cycle cannot safely fix.
- A finding requires a product decision (scope, UX, data model) or
  conflicts with AGENTS.md/ARCHITECTURE.md invariants → escalate to the
  user with your analysis.
- You disagree with Codex about whether a finding is a real defect →
  escalate; never silently skip a security finding.
- Working tree contains changes you did not make.

## Hard rules (never violate, in any cycle)

- Never merge. Never enable auto-merge. The human merges.
- Never push to `main` or `dev`; never run on them.
- Never resolve GitHub review threads — Codex marks its own threads
  outdated on re-review; humans may resolve manually.
- Never fix `previous-review-active` findings that don't reproduce.
- One commit per cycle, on the current feature branch.

## Final report (always, whatever ended the loop)

Cycles run, findings fixed per cycle (with commits), tests added, check
results, deferred P3s with reasons, anything escalated, and the loop's end
state (READY_FOR_HUMAN_MERGE / awaiting Codex / max cycles / escalation).
