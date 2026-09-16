/**
 * Locating and running external scanners across platforms.
 *
 * `spawnSync` cannot be trusted to report a missing binary the same way
 * everywhere: with `shell: true` (which Windows needs for `.cmd` shims) a
 * missing command comes back as exit code 1 with a message on stderr, which is
 * indistinguishable from "the scanner ran and found something". Resolving the
 * executable up front removes the ambiguity, and lets us spawn `.exe` binaries
 * without a shell at all.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';

/** Absolute path to `tool`, or null when it is not on PATH. */
export function resolveTool(tool) {
  const probe = isWindows
    ? spawnSync('where', [tool], { encoding: 'utf8' })
    : spawnSync('command', ['-v', tool], { encoding: 'utf8', shell: '/bin/sh' });
  if (probe.status !== 0 || !probe.stdout) {
    return null;
  }
  const first = probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

/**
 * Runs an already-resolved executable, inheriting stdio. Batch shims (.cmd,
 * .bat) still need a shell; real executables do not, so they are spawned
 * directly and no argument-escaping question arises.
 */
export function runTool(executablePath, args) {
  const needsShell = /\.(cmd|bat)$/i.test(executablePath);
  const result = spawnSync(executablePath, args, {
    stdio: 'inherit',
    shell: needsShell,
  });
  return result.status ?? 1;
}
