#!/usr/bin/env node
/**
 * codex-auto-loop — deterministic orchestration helper for the autonomous
 * Claude ↔ Codex review-fix loop (/codex-auto-loop).
 *
 * THIS SCRIPT NEVER EDITS SOURCE CODE. A Node script cannot safely make code
 * changes; that is Claude Code's job. This helper does the deterministic
 * parts of one loop iteration:
 *   - guardrail checks (branch, gh auth, PR ↔ branch match)
 *   - fetches the latest-review findings via codex:summary --latest-only
 *   - decides the cycle status:
 *       STATUS: READY_FOR_HUMAN_MERGE     (no latest-review findings)
 *       STATUS: CLAUDE_FIX_REQUIRED       (findings saved for Claude to fix)
 *       STATUS: WAITING_FOR_CODEX_REVIEW  (latest Codex review predates the
 *                                          PR head — stop, wait for Codex)
 *     A clean Codex re-review arrives as a "didn't find any major issues"
 *     PR comment (no formal review is created), so the freshness check also
 *     accepts a clean-verdict comment that names the current head commit.
 *   - writes findings to .tmp/codex-latest-findings.md and prints precise
 *     instructions for Claude Code
 *
 * It never merges, never resolves review threads, never pushes, and never
 * comments — those actions belong to Claude Code (push/comment) and the
 * human (merge), per docs/development/codex-claude-loop.md.
 *
 * Inside a /codex-auto-loop session, the main Claude instance acts as the
 * ORCHESTRATOR: it delegates the routine steps below to the subagents in
 * .claude/agents/ (codex-review-reader, repo-investigator, fix-worker,
 * docs-worker, test-runner, secret-scan-worker, dataset-safety-worker,
 * ml-pipeline-reviewer, vision-event-contract-worker, final-reviewer) and
 * keeps triage, commit, push, and PR comments for itself.
 *
 * Usage:
 *   pnpm run codex:auto-loop -- --pr 2
 *   pnpm run codex:auto-loop -- --pr 2 --max-cycles 5 --dry-run
 *
 * Flags:
 *   --pr <number>            PR number (default: auto-detect current branch)
 *   --max-cycles <number>    echoed into Claude's instructions (default 3)
 *   --dry-run                report status only; write no files
 *   --no-push                instruct Claude to stop before push/comment
 *   --wait-seconds <number>  suggested wait before rechecking Codex (default 90)
 *   --allow-dirty            proceed despite uncommitted changes (default:
 *                            a dirty tree is a hard stop)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROTECTED_BRANCHES = new Set(['main', 'dev']);
const FINDINGS_FILE = path.join('.tmp', 'codex-latest-findings.md');
const ML_KEYWORDS =
  /(^|[^a-z0-9])(phase8|ml|training|dataset|cv-training)(?=[^a-z0-9]|$)/i;
// Paths whose presence in the PR diff marks it as an ML PR: the ml/
// workspace (dataset scripts + VisionEvent mapper) and the ML agent
// definitions themselves.
const ML_PATHS =
  /^(ml\/|\.claude\/agents\/(ml-pipeline-reviewer|dataset-safety-worker|vision-event-contract-worker)\.md$)/;

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    fail(
      `'${command}' is not installed or not on PATH.` +
        (command === 'gh'
          ? '\nInstall it from https://cli.github.com/ and run: gh auth login'
          : ''),
    );
  }
  return result;
}

function runOrFail(command, args, context) {
  const result = run(command, args);
  if (result.status !== 0) {
    fail(`${context}:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

function printMlMergeGates() {
  console.log('');
  console.log(
    'ML PR — safety gates are REQUIRED before handing off to human merge: ' +
      'spawn dataset-safety-worker, ml-pipeline-reviewer, and ' +
      'vision-event-contract-worker, then final-reviewer. Any ' +
      'UNSAFE/BLOCK/INCOMPATIBLE verdict must be treated as ' +
      'CLAUDE_FIX_REQUIRED even though Codex reported no findings.',
  );
}

const USAGE =
  'Supported options:\n' +
  '  --pr <n>             PR number (default: auto-detect from branch)\n' +
  '  --max-cycles <n>     max fix cycles for the Claude loop (default 3)\n' +
  '  --dry-run            report status only; write nothing\n' +
  '  --no-push            tell Claude to stop before push/comment\n' +
  '  --wait-seconds <n>   suggested Codex recheck wait (default 90)\n' +
  '  --allow-dirty        proceed despite uncommitted changes';

function parseArgs(argv) {
  const args = {
    pr: null,
    maxCycles: 3,
    dryRun: false,
    noPush: false,
    waitSeconds: 90,
    allowDirty: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') {
      args.pr = Number(argv[++i]);
    } else if (arg.startsWith('--pr=')) {
      args.pr = Number(arg.split('=')[1]);
    } else if (arg === '--max-cycles') {
      args.maxCycles = Number(argv[++i]);
    } else if (arg.startsWith('--max-cycles=')) {
      args.maxCycles = Number(arg.split('=')[1]);
    } else if (arg === '--wait-seconds') {
      args.waitSeconds = Number(argv[++i]);
    } else if (arg.startsWith('--wait-seconds=')) {
      args.waitSeconds = Number(arg.split('=')[1]);
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--no-push') {
      args.noPush = true;
    } else if (arg === '--allow-dirty') {
      args.allowDirty = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`Unknown option: ${arg}\n${USAGE}`);
    }
  }
  if (args.pr !== null && (!Number.isInteger(args.pr) || args.pr <= 0)) {
    fail('--pr requires a positive integer, e.g. --pr 2');
  }
  if (!Number.isInteger(args.maxCycles) || args.maxCycles <= 0) {
    fail('--max-cycles requires a positive integer');
  }
  if (!Number.isInteger(args.waitSeconds) || args.waitSeconds < 0) {
    fail('--wait-seconds requires a non-negative integer');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- Guardrails -----------------------------------------------------
  const authResult = run('gh', ['auth', 'status']);
  if (authResult.status !== 0) {
    fail(
      'GitHub CLI is not authenticated. Run: gh auth login\n' +
        (authResult.stderr || '').trim(),
    );
  }

  const branch = runOrFail(
    'git',
    ['branch', '--show-current'],
    'Could not determine the current branch',
  ).trim();
  if (!branch) {
    fail('Detached HEAD — check out a feature branch first.');
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    fail(
      `Refusing to run on protected branch '${branch}'. ` +
        'The Codex loop only runs on feature branches.',
    );
  }

  const dirty = runOrFail(
    'git',
    ['status', '--porcelain'],
    'Could not read git status',
  )
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (dirty.length > 0 && !args.allowDirty) {
    fail(
      'Working tree is dirty — refusing to report CLAUDE_FIX_REQUIRED, ' +
        'because a fix cycle would commit or push these unrelated edits:\n' +
        dirty.map((line) => `  ${line}`).join('\n') +
        '\nCommit or stash them first, or re-run with --allow-dirty if ' +
        'they were made by the current loop session.',
    );
  }

  // PR detection + branch match.
  const prArgs = args.pr !== null ? [String(args.pr)] : [];
  const prJson = runOrFail(
    'gh',
    [
      'pr',
      'view',
      ...prArgs,
      '--json',
      'number,url,state,headRefName,headRefOid,title',
    ],
    args.pr !== null
      ? `Could not load PR #${args.pr}`
      : 'Could not auto-detect a PR for the current branch (open one first, or pass --pr <n>)',
  );
  const pr = JSON.parse(prJson);
  const prTitle = typeof pr.title === 'string' ? pr.title : '';

  // ML detection is path-based (changed files under ml/ or the ML agent
  // definitions), with branch/title keywords as a fallback when the file
  // list cannot be fetched or parsed.
  let mlByFiles = false;
  let filesFetched = false;
  const filesResult = run('gh', [
    'pr',
    'view',
    String(pr.number),
    '--json',
    'files',
  ]);
  if (filesResult.status === 0) {
    try {
      const files = JSON.parse(filesResult.stdout).files;
      if (Array.isArray(files)) {
        filesFetched = true;
        mlByFiles = files.some((file) =>
          ML_PATHS.test(typeof file?.path === 'string' ? file.path : ''),
        );
      }
    } catch {
      // Unparseable output — treated like a failed fetch below.
    }
  }
  if (!filesFetched) {
    console.error(
      'note: could not read PR changed files — ML detection falls back to ' +
        'branch/title keywords.',
    );
  }
  const isMlPr =
    mlByFiles || ML_KEYWORDS.test(branch) || ML_KEYWORDS.test(prTitle);
  if (pr.state !== 'OPEN') {
    fail(`PR #${pr.number} is ${pr.state}, not OPEN — nothing to loop on.`);
  }
  if (pr.headRefName !== branch) {
    fail(
      `PR #${pr.number} head branch (${pr.headRefName}) does not match the ` +
        `current branch (${branch}). Check out the PR branch first.`,
    );
  }

  // --- Fetch latest-review findings ------------------------------------
  const summaryResult = run('node', [
    path.join('scripts', 'codex-review-summary.mjs'),
    '--pr',
    String(pr.number),
    '--latest-only',
  ]);
  if (summaryResult.status !== 0) {
    fail(
      `codex:summary failed:\n${(summaryResult.stderr || summaryResult.stdout || '').trim()}`,
    );
  }
  const summary = summaryResult.stdout;

  const counts = /_(\d+) latest-review \/ (\d+) previous-review-active \/ (\d+) outdated-or-resolved/.exec(
    summary,
  );
  if (!counts) {
    fail(
      'Could not parse finding counts from codex:summary output — the ' +
        'summary format may have changed. Refusing to guess.',
    );
  }
  const latestCount = Number(counts[1]);
  const previousCount = Number(counts[2]);

  // --- Review freshness -------------------------------------------------
  // After a fix cycle is pushed, the old review's threads still read as
  // `latest-review` until Codex reviews the new head. Comparing the PR head
  // SHA to the review's commit prevents re-fixing stale findings (or a
  // false READY) in that window.
  const reviewShaMatch = /Latest Codex review: commit `([0-9a-f]{4,40})`/.exec(
    summary,
  );
  const reviewSha = reviewShaMatch ? reviewShaMatch[1] : null;
  const headSha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
  const reviewCoversHead =
    headSha === ''
      ? true // cannot compare — do not block, but say so below
      : reviewSha !== null && headSha.startsWith(reviewSha);

  // A CLEAN Codex re-review does not create a formal review at all — Codex
  // posts a "Didn't find any major issues" PR comment naming the reviewed
  // commit (and reacts 👍). Without reading those comments, the loop would
  // report WAITING_FOR_CODEX_REVIEW forever after every clean verdict. A
  // comment explicitly naming the head SHA is authoritative for that head,
  // so no timestamp comparison with formal reviews is needed.
  let cleanVerdictCoversHead = false;
  if (!reviewCoversHead && headSha !== '') {
    const commentsJson = runOrFail(
      'gh',
      ['pr', 'view', String(pr.number), '--json', 'comments'],
      `Could not load PR #${pr.number} comments`,
    );
    const comments = JSON.parse(commentsJson).comments ?? [];
    cleanVerdictCoversHead = comments.some((comment) => {
      const login = (comment.author?.login ?? '').toLowerCase();
      if (!login.includes('codex')) return false;
      const body = comment.body ?? '';
      if (!/didn.{0,3}t find any major issues/i.test(body)) return false;
      const sha = /Reviewed commit:[^`]*`([0-9a-f]{7,40})`/i.exec(body);
      return sha !== null && headSha.startsWith(sha[1]);
    });
  }

  // --- Report ----------------------------------------------------------
  console.log(`Branch: ${branch}`);
  console.log(`PR: #${pr.number} (${pr.url})`);
  if (dirty.length > 0) {
    console.log('');
    console.log(
      'WARNING (--allow-dirty): working tree is dirty. Only proceed if ' +
        'these are changes made by the loop itself this session:',
    );
    for (const line of dirty) console.log(`  ${line}`);
  }
  if (headSha === '') {
    console.log('');
    console.log(
      'WARNING: could not read the PR head SHA — skipping the review ' +
        'freshness check.',
    );
  }
  console.log('');

  if (cleanVerdictCoversHead) {
    console.log('STATUS: READY_FOR_HUMAN_MERGE');
    console.log('');
    console.log(
      `Codex reviewed the current head ${headSha.slice(0, 7)} clean ` +
        `("didn't find any major issues", posted as a PR comment — clean ` +
        'verdicts do not create a formal review).',
    );
    if (latestCount > 0 || previousCount > 0) {
      console.log(
        `${latestCount + previousCount} active thread(s) from OLDER reviews ` +
          'remain on GitHub — do NOT re-fix them; verify they are stale and ' +
          'resolve them manually (or leave them for Codex to mark outdated).',
      );
    }
    if (isMlPr) {
      printMlMergeGates();
    }
    console.log(
      'Next step is HUMAN-ONLY: review the PR and merge it manually. ' +
        'Nothing here merges automatically.',
    );
    return;
  }

  if (!reviewCoversHead) {
    console.log('STATUS: WAITING_FOR_CODEX_REVIEW');
    console.log('');
    console.log(
      reviewSha === null
        ? `Codex has not reviewed PR #${pr.number} yet.`
        : `PR head is ${headSha.slice(0, 7)} but the latest Codex review ` +
            `covers ${reviewSha} — Codex has not reviewed the current head.`,
    );
    console.log(
      'Any findings the summary reports belong to an OLDER head — do NOT ' +
        'fix them again. Wait for Codex to re-review (typically a few ' +
        'minutes), then re-run this script. To nudge Codex, comment ' +
        '"@codex review" on the PR.',
    );
    return;
  }

  if (latestCount === 0) {
    console.log('STATUS: READY_FOR_HUMAN_MERGE');
    console.log('');
    console.log(
      `No active latest-review Codex findings on PR #${pr.number}.` +
        (previousCount > 0
          ? ` (${previousCount} previous-review-active thread(s) remain on ` +
            'GitHub — verified-stale threads awaiting Codex outdated-marking.)'
          : ''),
    );
    if (isMlPr) {
      printMlMergeGates();
    }
    console.log(
      'Next step is HUMAN-ONLY: review the PR and merge it manually. ' +
        'Nothing here merges automatically.',
    );
    return;
  }

  if (!args.dryRun) {
    mkdirSync(path.dirname(FINDINGS_FILE), { recursive: true });
    writeFileSync(FINDINGS_FILE, summary, 'utf8');
  }

  console.log(`STATUS: CLAUDE_FIX_REQUIRED (${latestCount} finding(s))`);
  console.log('');
  if (args.dryRun) {
    // The findings file is not written on dry runs, so print the summary —
    // otherwise "read the summary above" points at nothing.
    console.log('(dry-run: findings file NOT written; summary follows)');
    console.log('');
    console.log(summary);
  } else {
    console.log(`Findings saved to: ${FINDINGS_FILE}`);
  }
  console.log('');
  console.log('Instructions for Claude Code (one cycle, orchestrator mode):');
  console.log(
    `  1. codex-review-reader: read ${args.dryRun ? 'the summary above' : FINDINGS_FILE} ` +
      'and return the grouped work list.',
  );
  console.log(
    '  2. Orchestrator triage: ONLY latest-review findings (P0/P1/P2 ' +
      'blocking; P3 fix-or-defer). Never auto-fix previous-review-active ' +
      'findings — verify them against current code first.',
  );
  console.log(
    '  3. repo-investigator per finding → minimal plan; fix-worker applies ' +
      'it (docs-worker for docs-only findings). No scope creep.',
  );
  console.log(
    '  4. test-runner: pnpm run lint && pnpm run typecheck && pnpm run test ' +
      '&& pnpm run build && pnpm run security:secrets && pnpm run ml:test ' +
      '(secret-scan-worker on secret-scan failures).',
  );
  if (isMlPr) {
    console.log(
      '  4a. ML-flagged branch/PR: spawn dataset-safety-worker, ' +
        'ml-pipeline-reviewer, and vision-event-contract-worker before ' +
        'final-reviewer. Blockers: datasets/media/weights/training outputs ' +
        'committed, heavy ML deps required by normal CI, VisionEvent ' +
        'payload incompatible with Phase 7, reintroduction of evidence ' +
        'artifacts/metadata/URIs/storageKeys into app ingestion, or a ' +
        'secret-scan/CI/build/test failure.',
    );
  }
  console.log(
    '  5. final-reviewer on the full diff — must return PASS before commit.',
  );
  console.log(
    '  6. Orchestrator commits: "fix: address latest Codex review findings" ' +
      '(list each finding in the body).',
  );
  if (args.noPush) {
    console.log('  7. STOP (--no-push requested): do not push or comment.');
  } else {
    console.log(`  7. Orchestrator pushes to '${branch}' ONLY.`);
    console.log(
      '  8. Comment on the PR: "@codex review the latest changes and ' +
        'confirm whether all previous findings are resolved."',
    );
    console.log(
      `  9. Wait ~${args.waitSeconds}s for Codex, then re-run this script. ` +
        `If Codex has not re-reviewed yet, stop and tell the user to re-run ` +
        `/codex-auto-loop later. Max cycles: ${args.maxCycles}.`,
    );
  }
  console.log('');
  console.log(
    'Hard rules: never merge; never push to main/dev; never resolve GitHub ' +
      'review threads; stop on unfixable check failures or product decisions.',
  );
}

main();
