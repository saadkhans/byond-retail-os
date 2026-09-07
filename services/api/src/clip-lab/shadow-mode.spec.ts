import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for Clip Lab, enforced statically: the module
 * ORCHESTRATES existing shadow stages and READS their results — it
 * writes no table itself, opens no network/process/filesystem surface,
 * and never imports a checkout/order/payment/inventory service.
 */
describe('clip-lab module shadow mode', () => {
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

  it('writes NO table at all (every write belongs to the stage services)', () => {
    const write =
      /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(write);
      expect(match ? `${file} writes ${match[0]} — Clip Lab is read/orchestrate only` : null).toBeNull();
    }
  });

  it('never opens a network / process / filesystem surface', () => {
    const forbidden =
      /\bfetch\s*\(|axios|http\.request|https\.request|net\.connect|child_process|execSync|spawn\s*\(|readFileSync\s*\(|createReadStream/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(match ? `${file} references ${match[0]}` : null).toBeNull();
    }
  });

  it('never imports billing/checkout/payment/inventory services or the RTSP sampler', () => {
    const forbidden =
      /from\s+'[^']*(checkout|payments?|orders?|inventory|rtsp)\/[^']*'|CheckoutService|OrdersService|PaymentsService|InventoryService|RtspFrameSampler|VisionEventsService/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(match ? `${file} references ${match[0]}` : null).toBeNull();
    }
  });

  it('never touches storage keys, raw media, credentials, or stream schemes', () => {
    const forbidden = /storageKey|signedUrl|base64|rawPreview|errorDetail|credentialRef|rtsp:\/\/|modelPath|weightsPath/i;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(match ? `${file} references ${match[0]}` : null).toBeNull();
    }
  });

  it('cross-module service imports stay on the orchestration allowlist', () => {
    const serviceImport = /from\s+'\.\.\/([a-z-]+)\/[a-z-]+\.service'/g;
    const allowed = new Set([
      'prisma',
      'platform-modules',
      'video-ingest',
      'pickup-detection',
      'pickup-fusion',
      'pretrained-vision',
      'common', // audit actor type
    ]);
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(serviceImport)) {
        expect(allowed.has(match[1]) ? null : `${file} imports ${match[0]}`).toBeNull();
      }
    }
  });
});
