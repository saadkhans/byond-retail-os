#!/usr/bin/env node
/**
 * codex-review-summary — prints a Markdown summary of Codex review findings
 * for a PR, classified by review recency so stale-but-unresolved threads
 * stop generating noise.
 *
 * Classification per thread:
 *   latest-review            active, from the most recent Codex review
 *   previous-review-active   active, from an older Codex review (verify
 *                            against current code before re-fixing!)
 *   outdated                 GitHub marked the thread outdated (code moved)
 *   resolved                 thread resolved on GitHub
 *
 * Usage:
 *   pnpm run codex:summary                          # auto-detect PR
 *   pnpm run codex:summary -- --pr 2                # explicit PR number
 *   pnpm run codex:summary -- --pr 2 --latest-only  # latest review only
 *   pnpm run codex:summary -- --pr 2 --latest-only --include-previous-active
 *
 * Uses the developer's existing GitHub CLI auth (`gh auth login`).
 * No tokens are read from or stored in the repository. Read-only: this
 * script never resolves threads, comments, or merges.
 */
import { spawnSync } from 'node:child_process';
// Codex authorship is decided by STRICT equality against the shared exact
// allowlist — never by substring matching (a lookalike login such as
// 'codex-reviewer-user' must not be able to inject or supersede reviews).
import { isCodexBotLogin } from './codex-bot-logins.mjs';

// P0 is the highest blocking tier; unmarked findings sort last.
const PRIORITY_PATTERN = /\bP([0-3])\b/i;
const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3', 'Unprioritized'];

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function runGh(args, { parseJson = true } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    fail(
      "GitHub CLI ('gh') is not installed or not on PATH.\n" +
        'Install it from https://cli.github.com/ and run: gh auth login',
    );
  }
  if (result.status !== 0) {
    fail(
      `gh ${args.slice(0, 2).join(' ')} failed:\n${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return parseJson ? JSON.parse(result.stdout) : result.stdout;
}

function assertGhAuthenticated() {
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    fail(
      "GitHub CLI ('gh') is not installed or not on PATH.\n" +
        'Install it from https://cli.github.com/ and run: gh auth login',
    );
  }
  if (result.status !== 0) {
    fail(
      'GitHub CLI is not authenticated. Run: gh auth login\n' +
        (result.stderr || '').trim(),
    );
  }
}

const USAGE =
  'Supported options:\n' +
  '  --pr <n>                    explicit PR number (default: auto-detect)\n' +
  '  --latest-only               show only latest-review findings\n' +
  '  --include-previous-active   with --latest-only, also show older active\n' +
  '                              findings (no effect otherwise: the default\n' +
  '                              output already includes them)';

function parseArgs(argv) {
  const args = { pr: null, latestOnly: false, includePreviousActive: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') {
      args.pr = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--pr=')) {
      args.pr = Number(arg.split('=')[1]);
    } else if (arg === '--latest-only') {
      args.latestOnly = true;
    } else if (arg === '--include-previous-active') {
      args.includePreviousActive = true;
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
  return args;
}

function detectPullRequest() {
  const result = spawnSync(
    'gh',
    ['pr', 'view', '--json', 'number,title,url'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    fail(
      'Could not auto-detect a PR for the current branch.\n' +
        'Open one first (gh pr create) or pass an explicit number:\n' +
        '  pnpm run codex:summary -- --pr <number>',
    );
  }
  return JSON.parse(result.stdout);
}

// Reviews are paginated separately and exhaustively: recency classification
// is only sound if EVERY review is visible (a clean Codex re-review just
// outside a single page must never be missed).
const REVIEWS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          submittedAt
          author { login }
          commit { abbreviatedOid }
        }
      }
    }
  }
}`;

const MAX_REVIEW_PAGES = 30; // 3000 reviews — far beyond any sane PR

function fetchAllReviews(owner, name, number) {
  const reviews = [];
  let cursor = null;
  for (let page = 0; page < MAX_REVIEW_PAGES; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEWS_PAGE_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ];
    if (cursor) {
      args.push('-F', `cursor=${cursor}`);
    }
    const data = runGh(args);
    const connection = data?.data?.repository?.pullRequest?.reviews;
    if (!connection) {
      fail(`PR #${number} not found in ${owner}/${name}.`);
    }
    reviews.push(...(connection.nodes ?? []));
    if (!connection.pageInfo?.hasNextPage) {
      return reviews;
    }
    cursor = connection.pageInfo.endCursor;
    if (!cursor) {
      break;
    }
  }
  // Never classify against possibly-incomplete review data — stale threads
  // could masquerade as latest findings.
  return fail(
    `Could not fetch all reviews for PR #${number} (pagination incomplete ` +
      `after ${MAX_REVIEW_PAGES * 100} reviews). Refusing to classify ` +
      'findings against truncated review data.',
  );
}

// Review threads are ALSO paginated exhaustively: declaring the latest
// review "clean" is only sound if every thread was seen. Truncation fails
// loudly instead of silently classifying against partial data.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title
      url
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first: 50) {
            nodes {
              author { login }
              body
              path
              line
              originalLine
              url
              createdAt
              pullRequestReview {
                id
                submittedAt
                commit { abbreviatedOid }
              }
            }
          }
        }
      }
    }
  }
}`;

function firstLineTitle(body) {
  const line = (body || '')
    .split('\n')
    .map((candidate) =>
      candidate
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images (badges)
        .replace(/<[^>]+>/g, '') // inline HTML (<sub> etc.)
        .replace(/[*_`#>]/g, '')
        .trim(),
    )
    .find((candidate) => candidate.length > 0);
  if (!line) return '(no comment text)';
  return line.length > 110 ? `${line.slice(0, 107)}...` : line;
}

function detectPriority(body) {
  const match = PRIORITY_PATTERN.exec(body || '');
  return match ? `P${match[1]}` : 'Unprioritized';
}

function indent(text, prefix = '  ') {
  return (text || '')
    .trim()
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function findingMeta(root, status) {
  const sha = root.pullRequestReview?.commit?.abbreviatedOid ?? 'unknown';
  const created = root.createdAt ?? 'unknown';
  return `  \`[${status}]\` review commit \`${sha}\` · created ${created}`;
}

function locationOf(root) {
  if (!root.path) return '(no file location)';
  if (root.line != null) return `${root.path}:${root.line}`;
  return `${root.path}:${root.originalLine ?? '?'} (original position — may have moved)`;
}

function renderFindingsByPriority(lines, findings, status) {
  const byPriority = Object.fromEntries(
    PRIORITY_ORDER.map((priority) => [priority, []]),
  );
  for (const { root } of findings) {
    byPriority[detectPriority(root.body)].push(root);
  }
  for (const priority of PRIORITY_ORDER) {
    const roots = byPriority[priority];
    if (roots.length === 0) continue;
    lines.push(`### ${priority}`);
    lines.push('');
    for (const root of roots) {
      lines.push(`- **${locationOf(root)}** — ${firstLineTitle(root.body)}`);
      lines.push(findingMeta(root, status));
      lines.push(indent(root.body));
      lines.push(`  Source: ${root.url}`);
      lines.push('');
    }
  }
}

function main() {
  assertGhAuthenticated();

  const args = parseArgs(process.argv.slice(2));
  const pr = args.pr !== null ? { number: args.pr } : detectPullRequest();

  const repo = runGh(['repo', 'view', '--json', 'owner,name']);

  // Exhaustive: fails loudly if pagination cannot complete.
  const allReviews = fetchAllReviews(repo.owner.login, repo.name, pr.number);

  let pullRequest = null;
  const threads = [];
  let threadsCursor = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_REVIEW_PAGES) {
      fail(
        `Could not fetch all review threads for PR #${pr.number} ` +
          `(pagination incomplete after ${MAX_REVIEW_PAGES * 100} threads). ` +
          'Refusing to classify findings against truncated thread data.',
      );
    }
    const pageArgs = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${repo.owner.login}`,
      '-F',
      `name=${repo.name}`,
      '-F',
      `number=${pr.number}`,
    ];
    if (threadsCursor) {
      pageArgs.push('-F', `cursor=${threadsCursor}`);
    }
    const data = runGh(pageArgs);
    pullRequest = data?.data?.repository?.pullRequest;
    if (!pullRequest) {
      fail(`PR #${pr.number} not found in ${repo.owner.login}/${repo.name}.`);
    }
    threads.push(...(pullRequest.reviewThreads.nodes ?? []));
    if (!pullRequest.reviewThreads.pageInfo?.hasNextPage) {
      break;
    }
    threadsCursor = pullRequest.reviewThreads.pageInfo.endCursor;
    if (!threadsCursor) {
      fail(
        'Review-thread pagination reported more pages but no cursor — ' +
          'refusing to classify findings against incomplete thread data.',
      );
    }
  }

  // Only threads whose ROOT comment was authored by the exact Codex bot
  // login count as Codex threads — lookalike authors are excluded entirely.
  const codexThreads = threads
    .map((thread) => ({ thread, root: thread.comments.nodes[0] }))
    .filter(({ root }) => isCodexBotLogin(root?.author?.login));

  // The latest Codex review is derived from ALL of the PR's reviews
  // (paginated exhaustively above) — not from thread roots. A clean Codex
  // re-review (summary comment only, no inline threads) still counts as
  // "latest", so stale threads from older reviews can never masquerade as
  // latest-review findings. There is deliberately NO thread-root fallback:
  // fetchAllReviews fails loudly rather than returning truncated data.
  // Only formal reviews authored by the exact Codex bot login can become
  // the "latest Codex review" — a lookalike account's review can never
  // supersede (or masquerade as) a genuine Codex verdict.
  let latestReview = null;
  for (const review of allReviews) {
    if (!isCodexBotLogin(review.author?.login) || !review.submittedAt) continue;
    if (!latestReview || review.submittedAt > latestReview.submittedAt) {
      latestReview = review;
    }
  }
  if (!latestReview && codexThreads.length > 0) {
    fail(
      'Codex review threads exist but no Codex review could be identified ' +
        'from the PR reviews — refusing to classify findings (they could be ' +
        'mislabeled as latest). Check the Codex bot login or API state.',
    );
  }

  function classify({ thread, root }) {
    if (thread.isResolved) return 'resolved';
    if (thread.isOutdated) return 'outdated';
    if (latestReview && root.pullRequestReview?.id === latestReview.id) {
      return 'latest-review';
    }
    return 'previous-review-active';
  }

  const classified = codexThreads.map((entry) => ({
    ...entry,
    status: classify(entry),
  }));
  const latest = classified.filter((c) => c.status === 'latest-review');
  const previousActive = classified.filter(
    (c) => c.status === 'previous-review-active',
  );
  const ignoredThreads = classified.filter(
    (c) => c.status === 'resolved' || c.status === 'outdated',
  );

  const showPrevious = !args.latestOnly || args.includePreviousActive;
  const showIgnored = !args.latestOnly;

  const lines = [];
  lines.push(`# Codex Review Summary for PR #${pr.number}`);
  lines.push('');
  lines.push(`${pullRequest.title} — ${pullRequest.url}`);
  if (latestReview) {
    lines.push('');
    lines.push(
      `Latest Codex review: commit \`${latestReview.commit?.abbreviatedOid ?? 'unknown'}\` · submitted ${latestReview.submittedAt}`,
    );
  }
  lines.push('');

  lines.push('## Latest Review Findings');
  lines.push('');
  if (latest.length === 0) {
    lines.push('_No active findings from the latest Codex review. 🎉_');
    lines.push('');
  } else {
    renderFindingsByPriority(lines, latest, 'latest-review');
  }

  if (showPrevious) {
    lines.push('## Previous Active Findings');
    lines.push('');
    if (previousActive.length === 0) {
      lines.push('_None._');
      lines.push('');
    } else {
      lines.push(
        '> ⚠️ From older Codex reviews — likely already fixed but not yet ' +
          'resolved/outdated on GitHub. **Verify against current code before ' +
          're-fixing.** Do not resolve GitHub threads automatically.',
      );
      lines.push('');
      renderFindingsByPriority(lines, previousActive, 'previous-review-active');
    }
  } else if (previousActive.length > 0) {
    lines.push(
      `_(${previousActive.length} previous-review-active finding(s) hidden — rerun with --include-previous-active to see them.)_`,
    );
    lines.push('');
  }

  if (showIgnored) {
    lines.push('## Outdated / ignored');
    lines.push('');
    if (ignoredThreads.length === 0) {
      lines.push('_None._');
    }
    for (const { thread, root, status } of ignoredThreads) {
      void thread;
      const sha = root.pullRequestReview?.commit?.abbreviatedOid ?? 'unknown';
      lines.push(
        `- \`[${status}]\` **${locationOf(root)}** — ${firstLineTitle(root.body)} (review \`${sha}\`, created ${root.createdAt}) ${root.url}`,
      );
    }
    lines.push('');
  }

  lines.push(
    `_${latest.length} latest-review / ${previousActive.length} previous-review-active / ` +
      `${ignoredThreads.length} outdated-or-resolved Codex thread(s). ` +
      'States come from the GitHub review-threads GraphQL API; when in doubt, follow the source links._',
  );

  console.log(lines.join('\n'));
}

main();
