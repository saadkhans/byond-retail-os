import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The store flow is the ONE module allowed to turn an observation into money,
 * so the guarantees the shadow modules get from their guard tests have to be
 * restated here from the other side.
 *
 * Two things are enforced:
 *
 *   1. The store flow never writes the journey tables directly. The
 *      observation stream is append-only and owned by the journey module; the
 *      bridge reads it and records its own projections, and every journey
 *      write goes through JourneyService. A direct write here would let the
 *      bridge rewrite history the reviewer is looking at.
 *
 *   2. Every shadow guard that existed before this module still exists. This
 *      phase must not have been made to pass by deleting the tests that make
 *      the shadow modules safe.
 */
describe('store-flow boundary', () => {
  const root = join(__dirname);

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
    });

  it('never writes journey observations or reviews directly', () => {
    const forbidden =
      /\bcustomerJourneyEvent(Review)?\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} calls ${match[0]} — the observation stream is append-only ` +
              'and owned by the journey module'
          : null,
      ).toBeNull();
    }
  });

  it('only ever touches the journey row itself to record commerce links', () => {
    // The bridge may bind a shopper, a session, an order and a settlement
    // status onto the journey. It may not change its status, decision or
    // timestamps — closing a journey is JourneyService's job, so that the
    // live-session ownership fence and the reconciliation rules still apply.
    const forbiddenFields = [
      'status',
      'decision',
      'decisionReason',
      'decidedAt',
      'startedAt',
      'endedAt',
      'locationId',
      'unitId',
    ];
    // Capture the payload of each customerJourney.update, bounded by the end
    // of that call so the scan can never run on into the next statement.
    const updatePayload =
      /customerJourney\s*\.\s*update\s*\(\s*\{(?:(?!\}\);)[\s\S])*?\bdata:\s*((?:(?!\}\);)[\s\S])*)/g;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(updatePayload)) {
        for (const field of forbiddenFields) {
          expect(
            new RegExp(`\\b${field}\\b`).test(match[1])
              ? `${file} writes CustomerJourney.${field} — only the commerce ` +
                  'links may be set here; closing a journey belongs to ' +
                  'JourneyService'
              : null,
          ).toBeNull();
        }
      }
    }
  });

  it('leaves every pre-existing shadow guard in place', () => {
    const modulesWithGuards = [
      'journey',
      'pickup-fusion',
      'camera',
      'clip-lab',
      'one-sku-bootstrap',
      'pilot-evaluation',
      'planogram',
      'pretrained-vision',
      'local-vision-runtime',
      'cv-dataset',
      'cv-evaluation',
    ];
    for (const moduleName of modulesWithGuards) {
      const guard = join(root, '..', moduleName, 'shadow-mode.spec.ts');
      const source = readFileSync(guard, 'utf8');
      // The guard must still ban the write surfaces, not merely exist.
      expect(source).toMatch(/checkoutSession|order|paymentIntent|inventory/);
      expect(source).toMatch(/create|update|upsert|delete/);
    }
  });
});
