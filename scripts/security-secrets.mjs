#!/usr/bin/env node
/**
 * security-secrets — honest local secret scan for `pnpm run security:secrets`.
 *
 * Runs gitleaks twice when it is installed: a history scan (`gitleaks
 * detect`) over committed git history, and a working-tree scan (`gitleaks
 * detect --no-git`) over directory contents, so newly staged/untracked
 * secrets fail locally instead of only after push. This script NEVER fakes
 * a passing scan: if gitleaks is missing, it exits non-zero so callers
 * cannot mistake "no scanner" for "no secrets". The GitHub-side
 * secret-scanning check remains the authoritative gate either way.
 *
 * Exit codes:
 *   0  clean (gitleaks ran both scans and found nothing)
 *   1  leaks found by either scan (treat as FAIL)
 *   2  scanner unavailable (gitleaks not installed — NOT a pass)
 */
import { spawnSync } from 'node:child_process';

const versionResult = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
if (versionResult.error || versionResult.status !== 0) {
  console.error(
    'security:secrets: UNAVAILABLE — gitleaks is not installed locally. ' +
      'Install it (https://github.com/gitleaks/gitleaks) or rely on the ' +
      'GitHub secret-scanning check. This is NOT a pass.',
  );
  process.exit(2);
}

function runScan(label, extraArgs) {
  const result = spawnSync(
    'gitleaks',
    ['detect', '--source', '.', '--redact', '--no-banner', ...extraArgs],
    { stdio: 'inherit' },
  );
  if (result.error) {
    console.error(
      `security:secrets: UNAVAILABLE — gitleaks ${label} scan failed to run: ${result.error.message}. This is NOT a pass.`,
    );
    process.exit(2);
  }
  return result.status ?? 2;
}

const historyStatus = runScan('history', []);
const workingTreeStatus = runScan('working-tree', ['--no-git']);

const failedScans = [];
if (historyStatus !== 0) failedScans.push(`history (exit ${historyStatus})`);
if (workingTreeStatus !== 0) {
  failedScans.push(`working-tree (exit ${workingTreeStatus})`);
}
if (failedScans.length > 0) {
  console.error(
    `security:secrets: FAIL — leaks reported by ${failedScans.join(' and ')} scan. See gitleaks output above.`,
  );
  process.exit(1);
}
process.exit(0);
