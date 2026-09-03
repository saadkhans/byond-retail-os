import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * READ-ONLY + LOCAL-ONLY + PATH-CONFINED guarantee for the local vision
 * runtime module, enforced statically (same discipline as the
 * pretrained-vision and cv-dataset guards):
 *
 * 1. This module writes NO table at all — its single database access is
 *    a tenant-scoped video asset read.
 * 2. No network surface, ever. The child process seam exists in ONE file
 *    (the worker runner); the storage-key → path seam in ONE file (the
 *    detector runtime).
 * 3. No raw media / credential / stream surface in source.
 */
describe('local-vision-runtime module shadow mode', () => {
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

  it('never writes ANY table', () => {
    const write =
      /prisma\s*\.\s*(\w+)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const match = readFileSync(file, 'utf8').match(write);
      expect(
        match ? `${file} writes ${match[0]} — read-only module violated` : null,
      ).toBeNull();
    }
  });

  it('never opens a network surface', () => {
    const forbidden =
      /\bfetch\s*\(|axios|http\.request|https\.request|net\.connect|node:http|node:https|node:net|node:dgram|WebSocket/;
    for (const file of sourceFiles(root)) {
      const match = readFileSync(file, 'utf8').match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — local-only ban violated` : null,
      ).toBeNull();
    }
  });

  it('spawns a child process ONLY from the worker runner', () => {
    const forbidden = /child_process|execFile|execSync|\bspawn\s*\(/;
    for (const file of sourceFiles(root)) {
      if (basename(file) === 'python-yolo-worker.runner.ts') {
        continue;
      }
      const match = readFileSync(file, 'utf8').match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — process seam must stay in the runner` : null,
      ).toBeNull();
    }
  });

  it('turns a storage key into a path ONLY in the detector runtime', () => {
    for (const file of sourceFiles(root)) {
      if (basename(file) === 'local-yolo-detector.runtime.ts') {
        continue;
      }
      const match = readFileSync(file, 'utf8').match(/internalPathFor/);
      expect(
        match ? `${file} references internalPathFor — path seam must stay in the runtime` : null,
      ).toBeNull();
    }
  });

  it('never touches raw media encodings, credentials, or stream schemes', () => {
    const forbidden = /base64|signedUrl|rawPreview|credentialRef|rtsp:\/\//i;
    for (const file of sourceFiles(root)) {
      const match = readFileSync(file, 'utf8').match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — media-policy risk` : null,
      ).toBeNull();
    }
  });

  it('never imports checkout/orders/payments/inventory services or the RTSP sampler', () => {
    const forbidden =
      /from\s+'[^']*(checkout|payments?|orders?|inventory|rtsp)\/[^']*'|CheckoutService|OrdersService|PaymentsService|InventoryService|RtspFrameSampler|VisionEventsService/;
    for (const file of sourceFiles(root)) {
      const match = readFileSync(file, 'utf8').match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — out of scope` : null,
      ).toBeNull();
    }
  });
});
