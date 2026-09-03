import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE + LOCAL-ONLY guarantee for the Phase 19 pretrained vision
 * module, enforced statically (same discipline as cv-dataset and the
 * one-SKU bootstrap guards):
 *
 * 1. The ONLY table this module writes is PretrainedVisionRun — its own
 *    sanitized evidence. No checkout, order, payment, settlement,
 *    inventory, or any other write.
 * 2. LOCAL-ONLY: no network client, no child process, no filesystem
 *    read — adapters derive evidence from already-persisted rows or
 *    deterministic lab stubs.
 * 3. No raw source/credential/path/media surface: no storage keys, no
 *    base64 frames, no RTSP schemes, no model/file paths.
 */
describe('pretrained-vision module shadow mode', () => {
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

  it('writes ONLY the pretrainedVisionRun table', () => {
    const write =
      /prisma\s*\.\s*(\w+)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(write)) {
        expect(
          match[1] === 'pretrainedVisionRun'
            ? null
            : `${file} writes prisma.${match[1]} — outside this module's own table`,
        ).toBeNull();
      }
    }
  });

  it('never opens a network / process / filesystem surface (local-only)', () => {
    const forbidden =
      /\bfetch\s*\(|axios|http\.request|https\.request|net\.connect|child_process|execSync|spawn\s*\(|readFileSync\s*\(|createReadStream/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — local-only ban violated` : null,
      ).toBeNull();
    }
  });

  it('never imports billing/checkout/payment/inventory services or the RTSP sampler', () => {
    const forbidden =
      /from\s+'[^']*(checkout|payments?|orders?|inventory|rtsp)\/[^']*'|CheckoutService|OrdersService|PaymentsService|InventoryService|RtspFrameSampler|VisionEventsService/;
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
      /storageKey|signedUrl|base64|rawPreview|errorDetail|credentialRef|rtsp:\/\/|modelPath|weightsPath/i;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — media-policy risk` : null,
      ).toBeNull();
    }
  });

  it('consumes the local runtime through its PORT and token only — never a runtime class', () => {
    // Phase 20: the detector slot is backed by the local-vision-runtime
    // module. This module may import its pure port types, its DI token,
    // and (from the Nest module file only) the module class — never the
    // registry, worker runner, or runtime implementation.
    const runtimeImport = /from\s+'\.\.\/local-vision-runtime\/([a-z.-]+)'/g;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const isModuleFile = file.endsWith('pretrained-vision.module.ts');
      for (const match of source.matchAll(runtimeImport)) {
        const allowed =
          match[1] === 'local-vision-runtime.port' ||
          match[1] === 'local-vision-runtime.tokens' ||
          (isModuleFile && match[1] === 'local-vision-runtime.module');
        expect(
          allowed
            ? null
            : `${file} imports ${match[0]} — runtime implementation reached past the port`,
        ).toBeNull();
      }
    }
  });

  it('cross-module service imports stay on the read-only allowlist', () => {
    const serviceImport = /from\s+'\.\.\/([a-z-]+)\/[a-z-]+\.service'/g;
    const allowed = new Set([
      'prisma',
      'platform-modules', // isEnabledForTenant only (video boundary)
      'planogram', // soft SKU-narrowing prior (its own guard pins writes)
    ]);
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(serviceImport)) {
        expect(
          allowed.has(match[1])
            ? null
            : `${file} imports ${match[0]} — outside the allowlist`,
        ).toBeNull();
      }
    }
  });
});
