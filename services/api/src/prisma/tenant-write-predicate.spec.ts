import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ONE repo-wide guard for the tenancy invariant this codebase keeps
 * relearning the hard way:
 *
 *   A destructive Prisma write must carry the tenant IN the write
 *   predicate — never rely only on a preceding tenant-scoped lookup.
 *
 * The rule itself is older than this file: `locations.repository.spec.ts`
 * pinned it for locations, `procurement.service.spec.ts` for procurement,
 * `checkout-promotions.spec.ts` for checkout. Each of those was written
 * AFTER the bug was found in that module, and each only ever watched its
 * own module. The pattern was found nine times across four modules anyway,
 * because it is copied from module to module faster than a per-module spec
 * can be written. This spec watches `src/**` instead, so the tenth copy
 * fails in CI the first time it is written rather than the first time
 * somebody audits that module.
 *
 * Why the predicate and not the lookup: `findFirst({ where: { id,
 * tenantId } })` followed by `update({ where: { id } })` is two statements.
 * Between them the row can change tenant-visibility (a soft delete, a
 * re-parent, a restore), the `id` can be reassigned by a later refactor to
 * something the lookup never validated, or the lookup can simply be edited
 * away. `update({ where: { id_tenantId: { id, tenantId } } })` cannot: the
 * database itself refuses to touch another tenant's row. It costs nothing —
 * every tenant-scoped model in this schema except the handful listed under
 * MODELS_WITHOUT_COMPOSITE_KEY already carries `@@unique([id, tenantId])`.
 *
 * HOW IT WORKS
 * ------------
 * Static analysis over source text, in the style of the repo's other
 * grep-guards (`esl/vendor-neutrality.spec.ts`, `store-flow/boundary.spec.ts`,
 * the per-module `shadow-mode.spec.ts` guards). It does not need a
 * database, a Prisma client, or
 * a running Nest app:
 *
 *  1. Parse `prisma/schema.prisma` for every model and whether it has a
 *     `tenantId` field. A model without one is not tenant-scoped and is out
 *     of scope structurally — no allowlist entry needed.
 *  2. Walk `src/**` for non-spec `.ts` files.
 *  3. Blank out comments and string/template bodies, so a write that only
 *     appears in prose (`// then tx.product.update() runs`) is not reported.
 *  4. Find `.<delegate>.<op>(` for the destructive ops, where `<delegate>`
 *     is the Prisma delegate name of a model in the schema. The receiver is
 *     deliberately unconstrained: `this.prisma.x`, `tx.x`, `client.x` and a
 *     delegate reached off the end of a multi-line chain all match.
 *  5. Extract that call's `where:` value by brace matching and require the
 *     literal `tenantId` to appear somewhere inside it.
 *
 * Step 5 is intentionally shallow. `{ id_tenantId: { id, tenantId } }`,
 * `{ id, tenantId }`, `{ tenantId, versionId }` and
 * `this.scope(tenantId, { id })` all pass; `{ id }` and `{ id: before.id }`
 * do not. A predicate that mentions the tenant but gets it wrong is a code
 * review's job, not a grep's — the failure mode this guard exists for is the
 * tenant being absent altogether.
 */
describe('tenant-scoped destructive writes carry the tenant in the predicate', () => {
  const SRC_ROOT = join(__dirname, '..');
  const SCHEMA = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

  const DESTRUCTIVE_OPS = [
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
  ] as const;
  type WriteOp = (typeof DESTRUCTIVE_OPS)[number];

  interface WriteSite {
    readonly file: string;
    readonly line: number;
    readonly model: string;
    readonly op: WriteOp;
    readonly where: string;
  }

  /**
   * THE ALLOWLIST IS THE AUDIT TRAIL.
   *
   * Every entry is a write on a tenant-scoped model that deliberately does
   * NOT name the tenant in its predicate. Adding one is a decision to be
   * argued for in the `reason`, not a way to silence the guard. `occurrences`
   * is exact: a second, unrelated write of the same model and op in the same
   * file fails until somebody looks at it and updates the count on purpose.
   *
   * A stale entry fails too (see 'the allowlist has no stale entries'), so
   * an exemption cannot outlive the code that needed it.
   *
   * NOT allowlisted here, because they are out of scope structurally rather
   * than by exception:
   *  - Models with no `tenantId` field at all (Permission, PlatformModule,
   *    RolePermission, Tenant). There is no tenant to put in the predicate.
   *  - Writes whose predicate names the tenant indirectly but literally,
   *    e.g. `where: this.scope(tenantId, { id })` in esl.repository.ts —
   *    `TenantScopedRepository.scope()` injects the tenant, and the token
   *    `tenantId` is right there in the predicate.
   */
  const ALLOWLIST: ReadonlyArray<{
    readonly file: string;
    readonly model: string;
    readonly op: WriteOp;
    readonly occurrences: number;
    readonly reason: string;
  }> = [
    {
      file: 'seed/seeders.ts',
      model: 'UserRole',
      op: 'upsert',
      occurrences: 1,
      reason:
        'Seeds the PLATFORM admin role grant. Three reasons this one cannot ' +
        'and must not carry a tenant: the row is created with tenantId: ' +
        'null on purpose (a platform user belongs to no tenant, see ' +
        'platform-sandbox handling in AuthGuard); UserRole has no ' +
        '@@unique([id, tenantId]) to address it by, only its natural key ' +
        'userId_roleId, which IS the correct unique here; and the seeder is ' +
        'a trusted operator script run against the whole database with no ' +
        'request tenant in scope at all. It is unreachable from any HTTP ' +
        'route.',
    },
  ];

  /**
   * Tenant-scoped models that have no `@@unique([id, tenantId])`, so a
   * single-row `delete`/`update` cannot address them by a tenant-carrying
   * unique. Recorded here as documentation for anyone fixing a future
   * violation on one of them: the fix is `deleteMany`/`updateMany` with the
   * tenant in the predicate (what `products.repository.ts` does for
   * ProductBarcode), or a migration adding the composite key — not dropping
   * the tenant. This list is descriptive; the guard does not enforce it,
   * because a new model legitimately arrives without the key and gets it in
   * the same phase.
   */
  const MODELS_WITHOUT_COMPOSITE_KEY = [
    'AuditLog',
    'InventoryLevel',
    'PickupFusionRun',
    'ProductBarcode',
    'ProductReferenceEmbedding',
    'Role',
    'TenantModule',
    'UserRole',
    'VideoGroundTruth',
  ];

  // ------------------------------------------------------------- schema

  /** Model name -> is it tenant-scoped (does it have a `tenantId` field). */
  const readModels = (): Map<string, boolean> => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const models = new Map<string, boolean>();
    const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let match = modelBlock.exec(schema);
    while (match) {
      models.set(match[1], /^\s*tenantId\s/m.test(match[2]));
      match = modelBlock.exec(schema);
    }
    return models;
  };

  const models = readModels();

  /** Prisma's delegate name for a model is its lower-camel form. */
  const delegates = new Map<string, string>();
  for (const name of models.keys()) {
    delegates.set(name[0].toLowerCase() + name.slice(1), name);
  }

  // ------------------------------------------------------------ sources

  const collectSources = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') {
          continue;
        }
        files.push(...collectSources(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
    return files;
  };

  // ----------------------------------------------------------- analysis

  /**
   * Replace the BODY of every comment and string/template literal with
   * spaces, preserving length and newlines so offsets and line numbers stay
   * exact. Without this, a `.product.update(` written inside an explanatory
   * comment (there is one in `products.service.ts`) is reported as a
   * violation nobody can fix.
   */
  const blankNonCode = (source: string): string => {
    const out = source.split('');
    const blank = (from: number, to: number): void => {
      for (let i = from; i < to && i < out.length; i += 1) {
        if (out[i] !== '\n') {
          out[i] = ' ';
        }
      }
    };
    let i = 0;
    while (i < source.length) {
      const two = source.slice(i, i + 2);
      if (two === '//') {
        const end = source.indexOf('\n', i);
        const stop = end < 0 ? source.length : end;
        blank(i, stop);
        i = stop;
      } else if (two === '/*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end < 0 ? source.length : end + 2;
        blank(i, stop);
        i = stop;
      } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
        const quote = source[i];
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '\\') {
            j += 2;
            continue;
          }
          if (source[j] === quote) {
            j += 1;
            break;
          }
          if (quote !== '`' && source[j] === '\n') {
            break;
          }
          j += 1;
        }
        blank(i + 1, j - 1 >= i + 1 ? j - 1 : i + 1);
        i = j;
      } else {
        i += 1;
      }
    }
    return out.join('');
  };

  /** Slice the balanced `(...)` argument list starting just after `(`. */
  const balancedTo = (source: string, openAt: number, close: string): number => {
    const open = close === ')' ? '(' : '{';
    let depth = 1;
    let i = openAt;
    while (i < source.length && depth > 0) {
      if (source[i] === open) {
        depth += 1;
      } else if (source[i] === close) {
        depth -= 1;
      }
      i += 1;
    }
    return i - 1;
  };

  /**
   * The `where:` value of a call's argument object: a `{...}` literal, or
   * whatever expression runs to the next top-level comma (covering
   * `where: this.scope(tenantId, { id })` and `where: someWhere`).
   */
  const whereClause = (args: string): string | null => {
    const at = /\bwhere\s*:/.exec(args);
    if (!at) {
      return null;
    }
    let i = at.index + at[0].length;
    while (i < args.length && /\s/.test(args[i])) {
      i += 1;
    }
    if (args[i] === '{') {
      return args.slice(i, balancedTo(args, i + 1, '}') + 1);
    }
    let depth = 0;
    let j = i;
    while (j < args.length) {
      const ch = args[j];
      if (ch === '{' || ch === '[' || ch === '(') {
        depth += 1;
      } else if (ch === '}' || ch === ']' || ch === ')') {
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        break;
      }
      j += 1;
    }
    return args.slice(i, j).trim();
  };

  /** Every destructive Prisma write in one file's source text. */
  const findWriteSites = (source: string, file: string): WriteSite[] => {
    const code = blankNonCode(source);
    const call = new RegExp(
      `\\.\\s*(\\w+)\\s*\\.\\s*(${DESTRUCTIVE_OPS.join('|')})\\s*\\(`,
      'g',
    );
    const sites: WriteSite[] = [];
    let match = call.exec(code);
    while (match) {
      const model = delegates.get(match[1]);
      if (model) {
        const argsEnd = balancedTo(code, match.index + match[0].length, ')');
        const args = code.slice(match.index + match[0].length, argsEnd);
        sites.push({
          file,
          line: code.slice(0, match.index).split('\n').length,
          model,
          op: match[2] as WriteOp,
          where: whereClause(args) ?? '',
        });
      }
      match = call.exec(code);
    }
    return sites;
  };

  const carriesTenant = (site: WriteSite): boolean =>
    site.where.includes('tenantId');

  const sources = collectSources(SRC_ROOT);
  const writeSites = sources.flatMap((file) =>
    findWriteSites(
      readFileSync(file, 'utf8'),
      relative(SRC_ROOT, file).split(sep).join('/'),
    ),
  );

  const violations = writeSites.filter(
    (site) => models.get(site.model) === true && !carriesTenant(site),
  );

  const exemptionKey = (entry: {
    file: string;
    model: string;
    op: WriteOp;
  }): string => `${entry.file} :: ${entry.model}.${entry.op}`;

  // ------------------------------------------------- anti-vacuity checks
  //
  // Two guards in this repo were found to have been passing vacuously for
  // months. These four tests make that impossible here: if the schema parse,
  // the file walk, the call scan or the detector itself silently stops
  // working, the suite goes red rather than quietly green.

  it('parsed the schema and knows which models are tenant-scoped', () => {
    expect(models.size).toBeGreaterThan(60);
    expect([...models.values()].filter(Boolean).length).toBeGreaterThan(50);
    // Spot-checks in both directions.
    expect(models.get('Product')).toBe(true);
    expect(models.get('CheckoutSession')).toBe(true);
    expect(models.get('Tenant')).toBe(false);
    expect(models.get('Permission')).toBe(false);
  });

  it('walked the whole api source tree', () => {
    expect(sources.length).toBeGreaterThan(150);
    const relatives = sources.map((file) =>
      relative(SRC_ROOT, file).split(sep).join('/'),
    );
    for (const expected of [
      'pricing/pricing.repository.ts',
      'esl/esl.repository.ts',
      'checkout/checkout-sessions.repository.ts',
      'procurement/procurement.repository.ts',
      'locations/locations.repository.ts',
    ]) {
      expect(relatives).toContain(expected);
    }
  });

  it('found the destructive write sites it is meant to police', () => {
    expect(writeSites.length).toBeGreaterThan(120);
    // The modules the bug was actually found in must all be represented.
    for (const dir of ['pricing/', 'esl/', 'checkout/', 'procurement/']) {
      expect(writeSites.some((site) => site.file.startsWith(dir))).toBe(true);
    }
    // Every op this guard claims to cover is exercised by real code.
    for (const op of DESTRUCTIVE_OPS) {
      expect(writeSites.some((site) => site.op === op)).toBe(true);
    }
  });

  it('detects an unscoped write and accepts a scoped one', () => {
    const fixture = [
      'const bad = await tx.product.update({',
      '  where: { id: before.id },',
      '  data,',
      '});',
      'const good = await tx.product.update({',
      '  where: { id_tenantId: { id: before.id, tenantId: scoped } },',
      '  data,',
      '});',
      'const alsoGood = await tx.product.updateMany({',
      '  where: { id, tenantId: scoped, deletedAt: null },',
      '  data,',
      '});',
      '// a write named in a comment is prose: tx.product.delete({ where: { id } })',
      "const message = 'tx.product.delete({ where: { id } })';",
    ].join('\n');

    const found = findWriteSites(fixture, 'fixture.ts');
    expect(found).toHaveLength(3);
    expect(found.filter((site) => !carriesTenant(site))).toEqual([
      expect.objectContaining({ model: 'Product', op: 'update', line: 1 }),
    ]);
    expect(found.filter(carriesTenant)).toHaveLength(2);

    // A model with no tenantId column is out of scope, not a violation.
    const untenanted = findWriteSites(
      'await tx.tenant.update({ where: { id } , data });',
      'fixture.ts',
    );
    expect(untenanted).toHaveLength(1);
    expect(
      untenanted.filter((site) => models.get(site.model) === true),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------- the rule

  it('no destructive write on a tenant-scoped model omits the tenant', () => {
    const allowed = new Map(
      ALLOWLIST.map((entry) => [exemptionKey(entry), entry.occurrences]),
    );
    const seen = new Map<string, number>();
    const offenders: string[] = [];

    for (const site of violations) {
      const key = exemptionKey(site);
      const budget = allowed.get(key) ?? 0;
      const used = (seen.get(key) ?? 0) + 1;
      seen.set(key, used);
      if (used <= budget) {
        continue;
      }
      offenders.push(
        `${site.file}:${site.line} — ${site.model}.${site.op}() has ` +
          `where: ${site.where.replace(/\s+/g, ' ')} which does not name the ` +
          `tenant. A tenant-scoped read before the write is not enough: put ` +
          `the tenant in the write predicate` +
          (MODELS_WITHOUT_COMPOSITE_KEY.includes(site.model)
            ? ` — ${site.model} has no @@unique([id, tenantId]), so name it ` +
              `as a filter, where: { id, tenantId }` +
              (site.op === 'delete' || site.op === 'update'
                ? `, which means switching this single-row ${site.op}() to ` +
                  `${site.op}Many()`
                : ``)
            : `, e.g. where: { id_tenantId: { id, tenantId } }`) +
          `. If it is genuinely an exception, add it to ALLOWLIST in ` +
          `src/prisma/tenant-write-predicate.spec.ts with a reason.`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const actual = new Map<string, number>();
    for (const site of violations) {
      const key = exemptionKey(site);
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
    const stale = ALLOWLIST.filter(
      (entry) => (actual.get(exemptionKey(entry)) ?? 0) !== entry.occurrences,
    ).map(
      (entry) =>
        `${exemptionKey(entry)} is allowlisted for ${entry.occurrences} ` +
        `write(s) but ${actual.get(exemptionKey(entry)) ?? 0} were found. ` +
        `An exemption must not outlive the code that needed it: update the ` +
        `count or delete the entry.`,
    );
    expect(stale).toEqual([]);
  });

  it('every allowlist entry explains itself', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(60);
      expect(entry.occurrences).toBeGreaterThan(0);
    }
  });
});
