#!/usr/bin/env node
/**
 * security-secrets — honest local secret scan for `pnpm run security:secrets`.
 *
 * Runs gitleaks against the working tree when it is installed. This script
 * NEVER fakes a passing scan: if gitleaks is missing, it exits non-zero so
 * callers cannot mistake "no scanner" for "no secrets". The GitHub-side
 * secret-scanning check remains the authoritative gate either way.
 *
 * Exit codes:
 *   0  clean scan (gitleaks ran and found nothing)
 *   1  leaks found (gitleaks findings — treat as FAIL)
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

const scanResult = spawnSync(
  'gitleaks',
  ['detect', '--source', '.', '--redact', '--no-banner'],
  { stdio: 'inherit' },
);
if (scanResult.error) {
  console.error(
    `security:secrets: UNAVAILABLE — gitleaks failed to run: ${scanResult.error.message}. This is NOT a pass.`,
  );
  process.exit(2);
}
process.exit(scanResult.status ?? 2);
