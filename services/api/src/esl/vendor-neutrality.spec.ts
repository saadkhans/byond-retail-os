import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Pins the Phase 28 vendor-neutrality invariant that AGENTS.md names
 * explicitly ("do not hardcode one ... ESL vendor"): the ESL core — ports,
 * logic, service, repository, controller and DTOs — compiles and tests
 * against the interface alone. A concrete label vendor is a new adapter
 * class under `adapters/` plus one line of module wiring, never a change to
 * anything else in this directory.
 *
 * Two things are checked, in the style of the Phase 9/10 guards:
 *
 * 1. No real ESL hardware vendor is named anywhere in the module, and no
 *    vendor SDK is a runtime dependency of the API.
 * 2. Nothing outside `esl.module.ts` imports a concrete adapter. The service
 *    reaches vendors only through ESL_VENDOR_REGISTRY, so a deployment can
 *    swap the adapter set without touching domain code.
 */
describe('esl module vendor neutrality', () => {
  /**
   * Matched with word boundaries rather than a bare substring: "pricer" is a
   * real ESL vendor, but it is also a substring of `PriceResolutionService`,
   * which the service legitimately injects.
   */
  const FORBIDDEN = [
    'solum',
    'imagotag',
    'vusion',
    'pricer',
    'hanshow',
    'displaydata',
    'zkong',
    'minew',
    'altierre',
    'opticon',
    'e-ink',
    'eink',
  ];

  const collectSources = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...collectSources(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
    return files;
  };

  const sources = collectSources(__dirname);

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources.map((file) => [file]))(
    'keeps %s free of ESL vendor names',
    (file) => {
      const source = readFileSync(file, 'utf8').toLowerCase();
      const named = FORBIDDEN.filter((vendor) =>
        new RegExp(
          `\\b${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        ).test(source),
      );
      expect(named).toEqual([]);
    },
  );

  it('keeps the API free of ESL vendor SDK dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(packageJson.dependencies ?? {})) {
      const lowered = name.toLowerCase();
      for (const vendor of FORBIDDEN) {
        expect(lowered).not.toContain(vendor);
      }
    }
  });

  it('confines concrete adapters to the module wiring', () => {
    const offenders = sources.filter(
      (file) =>
        basename(file) !== 'esl.module.ts' &&
        /from\s+'\.{1,2}\/adapters\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps every vendor SDK type off the port boundary', () => {
    const ports = readFileSync(join(__dirname, 'ports.ts'), 'utf8');
    // The port may only lean on Prisma's closed error vocabulary and its own
    // declarations — no import from an adapter, a vendor package, or a
    // transport library.
    const imports = [...ports.matchAll(/from\s+'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(['@prisma/client']);
  });
});
