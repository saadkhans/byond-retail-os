#!/usr/bin/env node
/**
 * Static analysis and vulnerability scanning.
 *
 *   pnpm run security:scan                    # gate on ERROR-severity only
 *   pnpm run security:scan -- --all-severities
 *   pnpm run security:scan -- --skip-trivy
 *
 * Locally the scanners are optional: a developer without Semgrep or Trivy
 * installed gets a clear message and a zero exit, because blocking every local
 * command on an optional binary teaches people to skip the script entirely.
 * Under CI (`CI` set) a missing scanner is a hard failure — the workflow
 * installs both, so absence there means the job is silently not scanning.
 */
import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolveTool, runTool } from './tool.mjs';

const args = new Set(process.argv.slice(2));
const allSeverities = args.has('--all-severities');
const underCi = Boolean(process.env.CI);
const severity = process.env.BYOND_SCAN_SEVERITY ?? 'HIGH,CRITICAL';
const rules = 'infra/semgrep/byond-rules.yml';

let failures = 0;
const skipped = [];

function scan(tool, toolArgs, installHint) {
  const executable = resolveTool(tool);
  if (!executable) {
    if (underCi) {
      console.error(`[security:scan] ${tool} is not installed and CI is set — failing.`);
      failures += 1;
      return;
    }
    console.warn(`[security:scan] ${tool} not installed; skipping. ${installHint}`);
    skipped.push(tool);
    return;
  }
  failures += runTool(executable, toolArgs);
}

if (!existsSync(rules)) {
  console.error(`[security:scan] missing rule file ${rules}`);
  process.exit(1);
}

console.log('[security:scan] Semgrep — repository hard rules and the CI ruleset');
const semgrepArgs = ['scan', '--error', '--quiet', '--config', rules, '--config', 'p/ci'];
if (!allSeverities) {
  semgrepArgs.push('--severity', 'ERROR');
}
scan('semgrep', semgrepArgs, 'Install with: python -m pip install semgrep');

if (!args.has('--skip-trivy')) {
  console.log(`[security:scan] Trivy — dependencies, secrets and misconfiguration (${severity})`);
  scan(
    'trivy',
    [
      'fs',
      '--scanners', 'vuln,secret,misconfig',
      '--severity', severity,
      '--ignore-unfixed',
      '--exit-code', '1',
      '.',
    ],
    'Install from: https://trivy.dev/latest/getting-started/installation/',
  );
}

if (failures > 0) {
  console.error('[security:scan] findings at or above the configured severity — see output above.');
  process.exit(1);
}
console.log(
  skipped.length > 0
    ? `[security:scan] clean, but ${skipped.join(' and ')} did not run.`
    : '[security:scan] clean.',
);
