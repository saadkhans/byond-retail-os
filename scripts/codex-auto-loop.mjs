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
 *       STATUS: READY_FOR_HUMAN_MERGE     (Codex is clean on the head AND
 *                                          GitHub checks all pass AND the PR
 *                                          is mergeable; for ML PRs, also a
 *                                          valid ML-gates attestation file
 *                                          for the head)
 *       STATUS: ML_SAFETY_GATES_REQUIRED  (ML PR is Codex-clean but no valid
 *                                          attestation file exists at
 *                                          .tmp/codex-ml-gates-pr-<PR>-<HEAD>.json)
 *       STATUS: CLAUDE_FIX_REQUIRED       (findings saved for Claude to fix)
 *       STATUS: WAITING_FOR_CODEX_REVIEW  (latest Codex review predates the
 *                                          PR head — stop, wait for Codex)
 *       STATUS: LOCAL_HEAD_MISMATCH       (local HEAD is not the PR head —
 *                                          sync the branch before any gates
 *                                          or attestations run)
 *       STATUS: PR_NOT_MERGEABLE          (GitHub reports merge conflicts —
 *                                          resolve them first)
 *       STATUS: GITHUB_CHECKS_FAILED      (a GitHub check run/context failed)
 *       STATUS: GITHUB_CHECKS_REQUIRED    (GitHub checks pending or not
 *                                          reporting — absence of checks is
 *                                          never treated as success)
 *     A clean Codex re-review arrives as a "didn't find any major issues"
 *     PR comment (no formal review is created), so the freshness check also
 *     accepts a clean-verdict comment that names the current head commit —
 *     but only from an exact Codex bot login (no substring matching), and
 *     only when no newer formal Codex review covers the same head (the
 *     newest Codex verdict always wins).
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
 *
 * READY_FOR_HUMAN_MERGE therefore means ALL of: Codex is clean on the
 * current head, the local HEAD equals the PR head, every GitHub check
 * (CI, secret scanning, ...) reports success, the PR is mergeable, and —
 * for ML PRs — a valid ML-gates attestation exists for the head.
 *
 * ML PRs and READY_FOR_HUMAN_MERGE: instead of a trust-me flag, the
 * orchestrator must run the four ML safety gates (dataset-safety-worker,
 * ml-pipeline-reviewer, vision-event-contract-worker, final-reviewer)
 * against the current head and, only if ALL pass, write an attestation file
 * .tmp/codex-ml-gates-pr-<PR>-<HEAD_SHA>.json recording each gate as "PASS".
 * This script verifies the file (PR number, exact head SHA, timestamp, all
 * four gates) before reporting READY_FOR_HUMAN_MERGE; an attestation for a
 * different SHA is ignored. Attestations must only ever be created while
 * the local HEAD equals the PR head — the script hard-stops with
 * LOCAL_HEAD_MISMATCH before any gate/attestation logic otherwise.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Exact allow-list of Codex review bot logins (shared with
// codex-review-summary.mjs). A clean-verdict PR comment counts ONLY if its
// author login is strictly equal to one of these — substring matches
// (e.g. 'codex-reviewer-user') are untrusted and ignored.
import { CODEX_BOT_LOGINS } from './codex-bot-logins.mjs';

const PROTECTED_BRANCHES = new Set(['main', 'dev']);
const FINDINGS_FILE = path.join('.tmp', 'codex-latest-findings.md');
const ML_KEYWORDS =
  /(^|[^a-z0-9])(phase8|ml|training|dataset|cv-training)(?=[^a-z0-9]|$)/i;
// Paths whose presence in the PR diff marks it as an ML PR: the ml/
// workspace (dataset scripts + VisionEvent mapper) and the ML agent
// definitions themselves.
const ML_PATHS =
  /^(ml\/|\.claude\/agents\/(ml-pipeline-reviewer|dataset-safety-worker|vision-event-contract-worker)\.md$)/;
// Blocked artifact extensions (model weights, media, data blobs). A file
// with one of these extensions ANYWHERE in the repo warrants the
// dataset-safety gate, so it marks the PR as ML regardless of directory.
const ML_ARTIFACT_EXTENSIONS =
  /\.(pt|pth|onnx|engine|safetensors|weights|ckpt|h5|tflite|mlmodel|pb|keras|joblib|gguf|bin|npy|npz|parquet|pkl|pickle|jpg|jpeg|png|webp|bmp|tif|tiff|gif|mp4|mov|avi|mkv|webm)$/i;

// A changed file counts as ML when it lives under an ML path, is the
// .gitignore (ML safety configuration — an overly broad trigger is safe,
// it just runs extra review), or carries a blocked artifact extension
// anywhere in the repo.
function isMlChangedPath(filePath) {
  return (
    ML_PATHS.test(filePath) ||
    filePath === '.gitignore' ||
    ML_ARTIFACT_EXTENSIONS.test(filePath)
  );
}

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

// Single source of truth for the ML safety gates that must pass before an
// ML PR may be handed to human merge.
const ML_MERGE_GATES = [
  'dataset-safety-worker',
  'ml-pipeline-reviewer',
  'vision-event-contract-worker',
  'final-reviewer',
];

// Attestation file the orchestrator writes AFTER actually running the four
// ML safety gates against the current head. Bound to PR number AND head SHA,
// so a stale attestation (older push) can never green-light a newer head.
function mlGatesAttestationFile(prNumber, headSha) {
  return path.join('.tmp', `codex-ml-gates-pr-${prNumber}-${headSha}.json`);
}

// Returns { file, createdAt } when a valid attestation exists for exactly
// this PR and head SHA, otherwise null. Valid means: parseable JSON with
// pr === prNumber, headSha === headSha (exact), a parseable createdAt
// timestamp, and every ML_MERGE_GATES entry strictly equal to "PASS"
// (synonyms like "SAFE"/"COMPATIBLE" are NOT accepted — the orchestrator
// records the gate outcome as "PASS").
function readMlGatesAttestation(prNumber, headSha) {
  if (headSha === '') return null;
  let data;
  try {
    data = JSON.parse(readFileSync(mlGatesAttestationFile(prNumber, headSha), 'utf8'));
  } catch {
    return null; // missing file or invalid JSON — no attestation
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  if (data.pr !== prNumber) return null;
  if (data.headSha !== headSha) return null;
  if (
    typeof data.createdAt !== 'string' ||
    Number.isNaN(Date.parse(data.createdAt))
  ) {
    return null;
  }
  const gates = data.gates;
  if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) {
    return null;
  }
  for (const gate of ML_MERGE_GATES) {
    if (gates[gate] !== 'PASS') return null;
  }
  return {
    file: mlGatesAttestationFile(prNumber, headSha),
    createdAt: data.createdAt,
  };
}

function printMlGatesRequired(prNumber, headSha) {
  console.log('');
  if (headSha === '') {
    console.log(
      'ML PR — Codex is clean, but the PR head SHA could not be read, so an ' +
        'ML safety-gate attestation cannot be verified. Fix gh output ' +
        '(gh pr view --json headRefOid) first; READY_FOR_HUMAN_MERGE is withheld.',
    );
    return;
  }
  const file = mlGatesAttestationFile(prNumber, headSha);
  console.log(
    'ML PR — Codex is clean on the current head, but no valid ML safety-gate ' +
      `attestation exists for it, so READY_FOR_HUMAN_MERGE is withheld. ` +
      `(Expected attestation file: ${file}; an attestation written for a ` +
      'different head SHA is stale and ignored.)',
  );
  console.log('');
  console.log('Instructions for Claude Code (orchestrator):');
  console.log(
    `  1. Run ALL four ML safety gates against the current head ${headSha}: ` +
      `${ML_MERGE_GATES.join(', ')}.`,
  );
  console.log(
    '  2. Only if EVERY gate returns clean, write the attestation file at ' +
      'exactly this path, then re-run this command:',
  );
  console.log(`     ${file}`);
  console.log('     with exactly this shape (each gate must be the string "PASS"):');
  const example = {
    pr: prNumber,
    headSha,
    createdAt: new Date().toISOString(),
    gates: Object.fromEntries(ML_MERGE_GATES.map((gate) => [gate, 'PASS'])),
  };
  for (const line of JSON.stringify(example, null, 2).split('\n')) {
    console.log(`     ${line}`);
  }
  console.log(
    '  3. If ANY gate fails (UNSAFE/BLOCK/INCOMPATIBLE), do NOT write the ' +
      'attestation — treat it as CLAUDE_FIX_REQUIRED: fix, push, and request ' +
      'a Codex re-review. NEVER hand a PR to human merge with a failed gate.',
  );
  console.log(
    '  Note: after any new push the head SHA changes, the old attestation ' +
      'is ignored, and the gates must be re-run against the new head.',
  );
  console.log(
    '  Note: gates inspect the LOCAL checkout, so an attestation may only ' +
      'be created while the local HEAD equals the PR head — this script ' +
      'verifies that and stops with LOCAL_HEAD_MISMATCH otherwise.',
  );
}

function printMlGatesAttested(attestation) {
  console.log(
    `ML PR: the ML safety gates (${ML_MERGE_GATES.join(', ')}) are attested ` +
      `PASS for this head by ${attestation.file} ` +
      `(created ${attestation.createdAt}).`,
  );
}

// --- GitHub merge-readiness gate ---------------------------------------
// READY_FOR_HUMAN_MERGE must never be reported while GitHub itself says the
// PR cannot merge cleanly: conflicts, failed checks, or checks that have
// not (yet) reported. Absence of checks is never treated as success.

// Outcomes that mean a check failed outright. CheckRun entries report a
// `conclusion`; classic StatusContext entries report a `state`.
const CHECK_FAILURE_OUTCOMES = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
]);
// Outcomes that count as a completed, passing check.
const CHECK_SUCCESS_OUTCOMES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function checkNameOf(entry) {
  return entry?.name || entry?.context || '(unnamed check)';
}

// Evaluates a `gh pr view --json statusCheckRollup` array. Returns
// { failed: [...names], pending: [...names] }; both empty means every
// check completed successfully. A missing/empty rollup is reported as
// pending — checks that are not reporting are NOT a pass.
function evaluateStatusCheckRollup(rollup) {
  const failed = [];
  const pending = [];
  if (!Array.isArray(rollup) || rollup.length === 0) {
    pending.push('(no GitHub checks reported on the PR head)');
    return { failed, pending };
  }
  for (const entry of rollup) {
    const outcome = String(entry?.conclusion ?? entry?.state ?? '')
      .trim()
      .toUpperCase();
    if (CHECK_SUCCESS_OUTCOMES.has(outcome)) continue;
    if (CHECK_FAILURE_OUTCOMES.has(outcome)) {
      failed.push(checkNameOf(entry));
    } else {
      // PENDING/QUEUED/IN_PROGRESS/EXPECTED, an empty conclusion (still
      // running), or anything unrecognized — treated as not-yet-passing.
      pending.push(checkNameOf(entry));
    }
  }
  return { failed, pending };
}

// Fetches FRESH mergeability + check data (a dedicated call right before
// the ready decision, so earlier fetches cannot go stale) and returns null
// when GitHub agrees the PR is merge-ready, otherwise { status, lines }
// describing the blocking condition.
function githubMergeGate(prNumber) {
  const stateJson = runOrFail(
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'mergeable,mergeStateStatus,statusCheckRollup',
    ],
    `Could not read GitHub merge state for PR #${prNumber}`,
  );
  let state;
  try {
    state = JSON.parse(stateJson);
  } catch {
    fail(
      `Could not parse GitHub merge state for PR #${prNumber} — refusing ` +
        'to report READY_FOR_HUMAN_MERGE without it.',
    );
  }
  const mergeable = String(state.mergeable ?? '').trim().toUpperCase();
  if (mergeable === 'CONFLICTING') {
    return {
      status: 'PR_NOT_MERGEABLE',
      lines: [
        `GitHub reports merge conflicts on PR #${prNumber} ` +
          `(mergeable: CONFLICTING, mergeStateStatus: ` +
          `${state.mergeStateStatus ?? 'unknown'}).`,
        'Resolve the conflicts (merge/rebase the base branch into this ' +
          'feature branch and push), wait for checks, then re-run this ' +
          'script. READY_FOR_HUMAN_MERGE is withheld until the PR is ' +
          'mergeable.',
      ],
    };
  }
  const { failed, pending } = evaluateStatusCheckRollup(
    state.statusCheckRollup,
  );
  if (failed.length > 0) {
    return {
      status: 'GITHUB_CHECKS_FAILED',
      lines: [
        'GitHub checks FAILED on the PR head:',
        ...failed.map((name) => `  - ${name}`),
        'Fix the failing checks (CI, secret scanning, ...) and push before ' +
          'this PR can be handed to human merge. Never bypass a failing ' +
          'check.',
      ],
    };
  }
  if (pending.length > 0) {
    return {
      status: 'GITHUB_CHECKS_REQUIRED',
      lines: [
        'GitHub checks are pending or not reporting on the PR head ' +
          '(absence of checks is never treated as success):',
        ...pending.map((name) => `  - ${name}`),
        'Wait for the checks to complete, then re-run this script.',
      ],
    };
  }
  if (mergeable !== 'MERGEABLE') {
    // UNKNOWN (or anything unexpected): GitHub is still computing
    // mergeability — treat like pending checks and re-check shortly.
    return {
      status: 'GITHUB_CHECKS_REQUIRED',
      lines: [
        `GitHub has not finished computing mergeability for PR ` +
          `#${prNumber} (mergeable: ${mergeable || 'UNKNOWN'}).`,
        'This usually resolves within seconds — re-run this script shortly.',
      ],
    };
  }
  return null;
}

function printMergeGateBlocked(gate) {
  console.log(`STATUS: ${gate.status}`);
  console.log('');
  console.log(
    'Codex is clean on the current head, but GitHub does not agree the PR ' +
      'is merge-ready:',
  );
  for (const line of gate.lines) console.log(line);
}

const USAGE =
  'Supported options:\n' +
  '  --pr <n>             PR number (default: auto-detect from branch)\n' +
  '  --max-cycles <n>     max fix cycles for the Claude loop (default 3)\n' +
  '  --dry-run            report status only; write nothing\n' +
  '  --no-push            tell Claude to stop before push/comment\n' +
  '  --wait-seconds <n>   suggested Codex recheck wait (default 90)\n' +
  '  --allow-dirty        proceed despite uncommitted changes\n' +
  '\n' +
  'READY_FOR_HUMAN_MERGE requires ALL of: Codex clean on the current head,\n' +
  'local HEAD equal to the PR head (else LOCAL_HEAD_MISMATCH), all GitHub\n' +
  'checks green (else GITHUB_CHECKS_FAILED / GITHUB_CHECKS_REQUIRED), and\n' +
  'a mergeable PR (else PR_NOT_MERGEABLE).\n' +
  '\n' +
  'ML PRs: READY_FOR_HUMAN_MERGE additionally requires a valid attestation\n' +
  'file at .tmp/codex-ml-gates-pr-<PR>-<HEAD_SHA>.json, written by the\n' +
  'orchestrator only after all four ML safety gates pass on the current\n' +
  'head with local HEAD == PR head (the script prints the exact path and\n' +
  'shape when it is missing).';

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

  // ML detection is path-based (changed files under ml/, the ML agent
  // definitions, .gitignore, or any blocked artifact extension — see
  // isMlChangedPath), with branch/title keywords as a fallback ONLY when
  // the file list cannot be fetched or parsed.
  let mlByFiles = false;
  let filesFetched = false;
  // Primary fetch: the REST files endpoint. Unlike `gh pr view --json files`
  // (new paths only), it reports `previous_filename` for renames, so moving
  // e.g. ml/models/x.bin to artifacts/x.bin still trips ML detection.
  const apiFilesResult = run('gh', [
    'api',
    `repos/{owner}/{repo}/pulls/${pr.number}/files`,
    '--paginate',
  ]);
  if (apiFilesResult.status === 0) {
    try {
      // --paginate concatenates the JSON arrays of successive pages
      // ("...][..."), which is not valid JSON — join them before parsing.
      const entries = JSON.parse(
        apiFilesResult.stdout.trim().replace(/\]\s*\[/g, ','),
      );
      if (Array.isArray(entries) && entries.length > 0) {
        filesFetched = true;
        mlByFiles = entries.some(
          (entry) =>
            isMlChangedPath(
              typeof entry?.filename === 'string' ? entry.filename : '',
            ) ||
            isMlChangedPath(
              typeof entry?.previous_filename === 'string'
                ? entry.previous_filename
                : '',
            ),
        );
      }
    } catch {
      // Unparseable output — fall back to `gh pr view` below.
    }
  }
  // Fallback fetch: `gh pr view --json files` (new paths only — renames out
  // of ml/ are invisible here, hence the REST endpoint above is preferred).
  if (!filesFetched) {
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
            isMlChangedPath(typeof file?.path === 'string' ? file.path : ''),
          );
        }
      } catch {
        // Unparseable output — treated like a failed fetch below.
      }
    }
  }
  if (!filesFetched) {
    console.error(
      'note: could not read PR changed files — ML detection falls back to ' +
        'branch/title keywords.',
    );
  }
  // Keywords are a FALLBACK only: when the changed files were fetched, they
  // alone decide — a successfully-inspected non-ML PR is never ML-flagged
  // just because its branch or title mentions e.g. "dataset".
  const isMlPr = filesFetched
    ? mlByFiles
    : ML_KEYWORDS.test(branch) || ML_KEYWORDS.test(prTitle);
  if (pr.state !== 'OPEN') {
    fail(`PR #${pr.number} is ${pr.state}, not OPEN — nothing to loop on.`);
  }
  if (pr.headRefName !== branch) {
    fail(
      `PR #${pr.number} head branch (${pr.headRefName}) does not match the ` +
        `current branch (${branch}). Check out the PR branch first.`,
    );
  }

  // --- Local HEAD ↔ PR head guard --------------------------------------
  // Safety gates and ML attestations inspect the LOCAL checkout, but every
  // attestation (and READY decision) is bound to the PR head SHA
  // (pr.headRefOid). If the local branch is ahead of or behind the PR head,
  // the gates would run against a commit that is not what GitHub merges —
  // hard stop before ANY findings/ready/attestation logic. Attestations
  // must only ever be created when local HEAD equals the PR head.
  const headSha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
  const localHead = runOrFail(
    'git',
    ['rev-parse', 'HEAD'],
    'Could not read the local HEAD SHA',
  ).trim();
  if (headSha !== '' && localHead !== headSha) {
    console.log(`Branch: ${branch}`);
    console.log(`PR: #${pr.number} (${pr.url})`);
    console.log('');
    console.log('STATUS: LOCAL_HEAD_MISMATCH');
    console.log('');
    console.log(`Local HEAD: ${localHead}`);
    console.log(`PR head:    ${headSha}`);
    console.log(
      'The local checkout does not match the PR head, so safety gates and ' +
        'attestations would run against the wrong commit. Nothing was ' +
        'checked and no status decision was made.',
    );
    console.log(
      'Sync your local branch to the PR head before running gates:',
    );
    console.log('  git fetch origin');
    console.log(
      `  git pull --ff-only origin ${branch}   ` +
        `(or: git reset --hard ${headSha} if the remote is authoritative)`,
    );
    console.log(
      'This script never resets your branch automatically. If the local ' +
        'branch is AHEAD (unpushed commits), push it instead so the PR head ' +
        'advances, then re-run this script.',
    );
    return;
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
  // The summary prints: Latest Codex review: commit `sha` · submitted <ISO>
  // Capture the submitted timestamp too (optionally — older formats without
  // it fall back to "review wins", see the precedence rule below).
  const reviewShaMatch =
    /Latest Codex review: commit `([0-9a-f]{4,40})`(?:[^\n]*submitted (\S+))?/.exec(
      summary,
    );
  const reviewSha = reviewShaMatch ? reviewShaMatch[1] : null;
  const reviewSubmittedAtMs =
    reviewShaMatch && reviewShaMatch[2] ? Date.parse(reviewShaMatch[2]) : NaN;
  const reviewCoversHead =
    headSha === ''
      ? true // cannot compare — do not block, but say so below
      : reviewSha !== null && headSha.startsWith(reviewSha);

  // A CLEAN Codex re-review does not create a formal review at all — Codex
  // posts a "Didn't find any major issues" PR comment naming the reviewed
  // commit (and reacts 👍). Without reading those comments, the loop would
  // report WAITING_FOR_CODEX_REVIEW forever after every clean verdict.
  // Trust model:
  //   - only comments whose author login is EXACTLY one of CODEX_BOT_LOGINS
  //     count — no substring matching ('codex-reviewer-user' is ignored);
  //   - the NEWEST Codex verdict wins: a clean comment is authoritative only
  //     if no formal Codex review covers the same head, or the comment is
  //     strictly newer than that review. A later formal review — with or
  //     without findings — supersedes an older clean comment, so an old
  //     clean verdict can never override newer active findings. If the
  //     review's submitted time cannot be parsed, the review is treated as
  //     newer (findings win).
  let cleanVerdictCoversHead = false;
  let supersededCleanVerdict = false;
  if (headSha !== '') {
    const commentsJson = runOrFail(
      'gh',
      ['pr', 'view', String(pr.number), '--json', 'comments'],
      `Could not load PR #${pr.number} comments`,
    );
    const comments = JSON.parse(commentsJson).comments ?? [];
    let hasCleanComment = false;
    let newestCleanCommentMs = null;
    for (const comment of comments) {
      const body = comment.body ?? '';
      if (!/didn.{0,3}t find any major issues/i.test(body)) continue;
      const sha = /Reviewed commit:[^`]*`([0-9a-f]{7,40})`/i.exec(body);
      if (sha === null || !headSha.startsWith(sha[1])) continue;
      const login = comment.author?.login ?? '';
      if (!CODEX_BOT_LOGINS.has(login)) {
        if (login.toLowerCase().includes('codex')) {
          console.error(
            `note: ignoring clean-verdict comment from '${login}' — not an ` +
              'exact Codex bot login.',
          );
        }
        continue;
      }
      hasCleanComment = true;
      const createdAtMs = Date.parse(comment.createdAt ?? '');
      if (
        !Number.isNaN(createdAtMs) &&
        (newestCleanCommentMs === null || createdAtMs > newestCleanCommentMs)
      ) {
        newestCleanCommentMs = createdAtMs;
      }
    }
    if (hasCleanComment) {
      if (!reviewCoversHead) {
        // No formal review covers this head — the clean comment is the only
        // Codex verdict for the current head and is authoritative.
        cleanVerdictCoversHead = true;
      } else if (
        newestCleanCommentMs !== null &&
        !Number.isNaN(reviewSubmittedAtMs) &&
        newestCleanCommentMs > reviewSubmittedAtMs
      ) {
        // The clean comment is strictly newer than the formal review that
        // covers the same head — the newest verdict wins.
        cleanVerdictCoversHead = true;
      } else {
        // The formal review covering this head is newer, or timestamps
        // could not be compared — the review supersedes the clean comment;
        // its findings (or zero-findings status) decide below.
        supersededCleanVerdict = true;
      }
    }
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
  if (supersededCleanVerdict) {
    console.log('');
    console.log(
      'Note: a Codex clean-verdict comment names the current head, but the ' +
        'latest formal Codex review covering the same head is newer (or ' +
        'timestamps could not be compared) — the review is authoritative, ' +
        'not the older clean comment.',
    );
  }
  console.log('');

  if (cleanVerdictCoversHead) {
    const attestation = isMlPr
      ? readMlGatesAttestation(pr.number, headSha)
      : null;
    const mlGatesPending = isMlPr && attestation === null;
    // Fresh GitHub mergeability/check gate — evaluated immediately before
    // READY can be printed. ML_SAFETY_GATES_REQUIRED prints first and is
    // unaffected by it.
    const mergeGate = mlGatesPending ? null : githubMergeGate(pr.number);
    if (mergeGate) {
      printMergeGateBlocked(mergeGate);
      return;
    }
    console.log(
      mlGatesPending
        ? 'STATUS: ML_SAFETY_GATES_REQUIRED'
        : 'STATUS: READY_FOR_HUMAN_MERGE',
    );
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
    if (mlGatesPending) {
      printMlGatesRequired(pr.number, headSha);
      return;
    }
    if (isMlPr) {
      printMlGatesAttested(attestation);
    }
    console.log(
      'GitHub agrees: all checks green and the PR is mergeable.',
    );
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
    const attestation = isMlPr
      ? readMlGatesAttestation(pr.number, headSha)
      : null;
    const mlGatesPending = isMlPr && attestation === null;
    // Fresh GitHub mergeability/check gate — evaluated immediately before
    // READY can be printed. ML_SAFETY_GATES_REQUIRED prints first and is
    // unaffected by it.
    const mergeGate = mlGatesPending ? null : githubMergeGate(pr.number);
    if (mergeGate) {
      printMergeGateBlocked(mergeGate);
      return;
    }
    console.log(
      mlGatesPending
        ? 'STATUS: ML_SAFETY_GATES_REQUIRED'
        : 'STATUS: READY_FOR_HUMAN_MERGE',
    );
    console.log('');
    console.log(
      `No active latest-review Codex findings on PR #${pr.number}.` +
        (previousCount > 0
          ? ` (${previousCount} previous-review-active thread(s) remain on ` +
            'GitHub — verified-stale threads awaiting Codex outdated-marking.)'
          : ''),
    );
    if (mlGatesPending) {
      printMlGatesRequired(pr.number, headSha);
      return;
    }
    if (isMlPr) {
      printMlGatesAttested(attestation);
    }
    console.log(
      'GitHub agrees: all checks green and the PR is mergeable.',
    );
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
