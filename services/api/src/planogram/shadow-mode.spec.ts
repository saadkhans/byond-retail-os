import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for the Phase 19 planogram module: planograms
 * are scoring EVIDENCE, so this module may write ONLY its own two
 * tables, and it must never reach a billing/checkout/payment/inventory
 * surface, a network client, or any raw media/credential field.
 */
describe('planogram module shadow mode', () => {
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

  it('writes ONLY the planogram tables', () => {
    const write =
      /(?:prisma|tx)\s*\.\s*(\w+)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;
    const allowed = new Set(['planogramRack', 'planogramCellAssignment']);
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(write)) {
        expect(
          allowed.has(match[1])
            ? null
            : `${file} writes ${match[1]} — outside the planogram tables`,
        ).toBeNull();
      }
    }
  });

  it('never opens a network / process / filesystem surface', () => {
    const forbidden =
      /\bfetch\s*\(|axios|http\.request|https\.request|net\.connect|child_process|execSync|spawn\s*\(|createReadStream/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — local-only ban violated` : null,
      ).toBeNull();
    }
  });

  it('never imports billing/checkout/payment/inventory services', () => {
    const forbidden =
      /from\s+'[^']*(checkout|payments?|orders?|inventory|rtsp)\/[^']*'|CheckoutService|OrdersService|PaymentsService|InventoryService|VisionEventsService/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — out of scope` : null,
      ).toBeNull();
    }
  });

  it('never touches storage keys, raw media, credentials, or stream schemes', () => {
    const forbidden =
      /storageKey|signedUrl|base64|rawPreview|errorDetail|credentialRef|rtsp:\/\//i;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — media-policy risk` : null,
      ).toBeNull();
    }
  });
});
