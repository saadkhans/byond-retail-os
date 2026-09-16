import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tier boundaries, enforced statically.
 *
 * ARCHITECTURE.md gives this service exactly two jobs: continuous
 * lightweight tracking that "produces tracking metadata, never product
 * decisions", and a trigger layer that turns moments into inference jobs.
 * Everything downstream — recognition, fusion, the basket, the ledger,
 * payment — belongs to the API.
 *
 * A grep-level guard is deliberate, and it is the same shape the API uses
 * for its own shadow-mode specs: it fails the moment ANY code path
 * acquires a forbidden capability, regardless of which branch a runtime
 * test happens to exercise.
 */

const SOURCE_ROOT = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

/**
 * Comments are stripped before matching. A guard that fires on prose is a
 * guard that punishes documenting the very rule it enforces — these files
 * explain at length that they must never name a product, and they should
 * be able to say so.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('tier boundary — the pipeline proposes, it never decides', () => {
  it('never mentions a product identity in tracking or trigger code', () => {
    // Tier 1 and tier 2 have no vocabulary for a product. If one appears,
    // the pipeline has started doing tier 3's job in the wrong process.
    const forbidden =
      /\b(sku|productId|productName|candidateSku|catalogId|barcode)\b/i;
    const scoped = [
      ...sourceFiles(join(SOURCE_ROOT, 'tracking')),
      ...sourceFiles(join(SOURCE_ROOT, 'trigger')),
    ];

    expect(scoped.length).toBeGreaterThan(0);
    for (const file of scoped) {
      const source = code(file);
      const match = source.match(forbidden);
      expect(
        match ? `${file} mentions ${match[0]} — tier 1/2 names no product` : null,
      ).toBeNull();
    }
  });

  it('never writes to commerce or inventory state', () => {
    // The same write vocabulary the API's shadow-mode guards ban. This
    // service has no database at all, and this test is what keeps it that
    // way when somebody reaches for a shortcut.
    const forbidden =
      /\b(order|orderLine|paymentIntent|paymentEvent|checkoutSession|checkoutSessionLine|inventoryLevel|inventoryMovement|basket|visionEvent)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = code(file);
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — commerce is the API's` : null,
      ).toBeNull();
    }
  });

  it('holds no database client', () => {
    const forbidden = /@prisma\/client|PrismaClient|new Pool\(/;
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = code(file);
      expect(source.match(forbidden)).toBeNull();
    }
  });

  it('writes no media to disk', () => {
    // Frames are measured and dropped. A file write here would turn a
    // tracking service into an unaudited recorder.
    const forbidden =
      /\b(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|mkdtemp)\b/;
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = code(file);
      const match = source.match(forbidden);
      expect(match ? `${file} calls ${match[0]} — no recording` : null).toBeNull();
    }
  });

  it('never spawns through a shell', () => {
    // The camera address lands in argv. A shell would make it syntax.
    //
    // Named entry points rather than a bare `exec(`: a regular
    // expression's own `exec` method would match that, and a guard that
    // cries wolf gets deleted.
    const forbidden =
      /\b(execSync|execFileSync|spawnSync)\s*\(|shell\s*:\s*true/;
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = code(file);
      const match = source.match(forbidden);
      expect(
        match ? `${file} uses ${match[0]} — argument vectors only` : null,
      ).toBeNull();
    }
  });
});

describe('vendor neutrality', () => {
  it('names no camera, model or cloud vendor in domain code', () => {
    // AGENTS.md: concrete vendors are plug-ins behind adapters, and core
    // logic must compile against the interface alone. ffmpeg is a system
    // utility behind a port, named only inside its own adapter.
    const forbidden =
      /\b(hikvision|axis-?communications|dahua|ubiquiti|deepstream|triton|yolov?\d|ultralytics|openai|anthropic|nvidia)\b/i;

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = code(file);
      const match = source.match(forbidden);
      expect(
        match ? `${file} names the vendor ${match[0]}` : null,
      ).toBeNull();
    }
  });

  it('keeps the frame-source tooling out of the domain layers', () => {
    // Where the tool MAY be named: its own adapter, the composition root
    // that chooses adapters, and the configuration enum an operator sets.
    // Where it may not: the tracking, trigger, job and pipeline logic,
    // which must compile against the ports alone.
    const domain = [
      ...sourceFiles(join(SOURCE_ROOT, 'trigger')),
      ...sourceFiles(join(SOURCE_ROOT, 'jobs')),
      ...sourceFiles(join(SOURCE_ROOT, 'pipeline')),
      ...sourceFiles(join(SOURCE_ROOT, 'tracking')).filter(
        (file) => !/ffmpeg-frame-source\.adapter\.ts$/.test(file),
      ),
    ];

    expect(domain.length).toBeGreaterThan(0);
    for (const file of domain) {
      const match = code(file).match(/ffmpeg/i);
      expect(
        match ? `${file} names the frame-source tooling directly` : null,
      ).toBeNull();
    }
  });
});
