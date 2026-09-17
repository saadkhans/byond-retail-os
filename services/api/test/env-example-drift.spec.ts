import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.env.example` and `src/config/env.validation.ts` cannot drift apart.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. The example file lagged the
 * validator from Phase 4 to Phase 36 — 5 uncommented keys against 62
 * declared ones — so anyone configuring a deployment from it was missing
 * everything added since, including the whole VIDEO_* block and TRUST_PROXY.
 * That compounds a trap this repository has already been bitten by:
 * `validateEnv` runs with `whitelist: true`, so a key that is NOT declared in
 * the validator is stripped before any module reads it. A missing key is
 * therefore SILENT — no warning, no failure, just a feature that never turns
 * on. Documentation that can silently rot is worse than none, so it is
 * pinned here instead.
 *
 * Both directions are checked:
 *
 *   validator → example   a declared key absent from the example is a
 *                         configuration option nobody deploying can find.
 *   example → validator   a key in the example that is NOT declared would be
 *                         whitelist-stripped at boot: the file would be
 *                         promising something the process ignores. The only
 *                         exceptions are the seed script's own variables,
 *                         listed explicitly below.
 */

const API_ROOT = join(__dirname, '..');

/**
 * Keys the example documents that the API config deliberately does not
 * declare: they are read by `prisma/seed.ts` (`pnpm run db:seed`), never by
 * a running API process, so declaring them would imply the server uses them.
 */
const SEED_ONLY_KEYS = [
  'SEED_PLATFORM_ADMIN',
  'SEED_ADMIN_EMAIL',
  'SEED_ADMIN_PASSWORD',
];

/** Every property name declared on the EnvironmentVariables class. */
function declaredKeys(): string[] {
  const source = readFileSync(
    join(API_ROOT, 'src/config/env.validation.ts'),
    'utf8',
  );
  const matches = source.matchAll(/^ {2}([A-Z][A-Z0-9_]*)[!?]?:/gm);
  return [...new Set([...matches].map((match) => match[1]))];
}

/** Every key the example mentions, set or commented out. */
function exampleKeys(): string[] {
  const source = readFileSync(join(API_ROOT, '.env.example'), 'utf8');
  const matches = source.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm);
  return [...new Set([...matches].map((match) => match[1]))];
}

describe('.env.example tracks env.validation.ts', () => {
  it('finds both files and a plausible number of keys', () => {
    expect(declaredKeys().length).toBeGreaterThan(50);
    expect(exampleKeys().length).toBeGreaterThan(50);
  });

  it('documents EVERY key the validator declares', () => {
    const documented = new Set(exampleKeys());
    const missing = declaredKeys().filter((key) => !documented.has(key));
    expect(
      missing.length === 0
        ? null
        : `services/api/.env.example is missing ${missing.length} key(s) ` +
            `declared in src/config/env.validation.ts: ${missing.join(', ')}` +
            ' — add each one (commented out, with a one-line comment saying' +
            ' what it does and its default) or a deployment configured from' +
            ' the example cannot know it exists.',
    ).toBeNull();
  });

  it('promises no key the validator would strip at boot', () => {
    const declared = new Set([...declaredKeys(), ...SEED_ONLY_KEYS]);
    const undeclared = exampleKeys().filter((key) => !declared.has(key));
    expect(
      undeclared.length === 0
        ? null
        : `services/api/.env.example documents ${undeclared.length} key(s) ` +
            `that src/config/env.validation.ts does not declare: ` +
            `${undeclared.join(', ')} — validateEnv whitelists, so these are` +
            ' stripped before any module reads them and would be silently' +
            ' dead. Declare them in the validator, or (if the seed script' +
            ' owns them) add them to SEED_ONLY_KEYS in this spec.',
    ).toBeNull();
  });

  it('carries no value that looks like a real secret', () => {
    const source = readFileSync(join(API_ROOT, '.env.example'), 'utf8');
    // Only assignments that are actually LIVE in the file (not commented).
    const assignments = [...source.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)];
    for (const [, key, rawValue] of assignments) {
      const value = rawValue.trim();
      if (/SECRET|PASSWORD|TOKEN|API_KEY/.test(key)) {
        // A secret in the example must be EMPTY — a value here is either a
        // live credential or one that fails the placeholder check at boot.
        expect(`${key}=${value}`).toBe(`${key}=`);
      }
      // No key material pasted into any value, secret-named or not.
      expect(value).not.toMatch(/^(sk-|ghp_|AKIA|eyJ)/);
    }
  });
});
