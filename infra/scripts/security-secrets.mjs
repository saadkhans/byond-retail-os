#!/usr/bin/env node
/**
 * Secret detection. Mirrors what .github/workflows/secrets.yml runs in CI so a
 * developer can catch a leak before it reaches a remote at all — once a secret
 * is pushed it must be rotated, not just deleted.
 *
 *   pnpm run security:secrets              # scan the working tree
 *   pnpm run security:secrets -- --history # scan the whole git history
 */
import process from 'node:process';
import { resolveTool, runTool } from './tool.mjs';

const wantsHistory = process.argv.slice(2).includes('--history');
const underCi = Boolean(process.env.CI);

const gitleaks = resolveTool('gitleaks');
if (!gitleaks) {
  if (underCi) {
    console.error('[security:secrets] gitleaks is not installed and CI is set — failing.');
    process.exit(1);
  }
  console.warn(
    '[security:secrets] gitleaks not installed; skipping. ' +
      'Install from: https://github.com/gitleaks/gitleaks#installing',
  );
  process.exit(0);
}

const status = runTool(
  gitleaks,
  wantsHistory
    ? ['detect', '--source', '.', '--redact', '--verbose']
    : ['detect', '--source', '.', '--no-git', '--redact', '--verbose'],
);

if (status !== 0) {
  console.error('[security:secrets] potential secrets found — rotate anything real, then remove it.');
  process.exit(1);
}
console.log('[security:secrets] clean.');
