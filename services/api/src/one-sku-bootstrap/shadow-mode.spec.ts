import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for the one-SKU bootstrap module, enforced
 * statically (same discipline as the cv-dataset guard) — and STRICTER:
 * this module is READ-ONLY.
 *
 * 1. NO Prisma write of any kind, on ANY delegate — not even its own
 *    tables (it has none). Uploads, reindexing, ground truth, runs, and
 *    corrections all go through their existing endpoints.
 * 2. No billing/checkout/order/payment surface, and no inventory
 *    MUTATION (a read-only stocked check is this module's business).
 * 3. No raw source/credential handling, no storage-key or raw-media
 *    fields, no VLM/model-training surface.
 */
describe('one-sku-bootstrap module shadow mode', () => {
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

  it('never calls a Prisma write method on ANY delegate (read-only module)', () => {
    const forbidden =
      /prisma\s*\.\s*\w+\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — read-only module violated` : null,
      ).toBeNull();
    }
  });

  it('never imports billing/checkout/payment services or the RTSP sampler', () => {
    const forbidden =
      /from\s+'[^']*(checkout|payments?|orders?|rtsp)\/[^']*'|CheckoutService|OrdersService|PaymentsService|RtspFrameSampler/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — out of scope` : null,
      ).toBeNull();
    }
  });

  it('never references credential slots or stream schemes', () => {
    const forbidden = /credentialRef|CAMERA_RTSP_SOURCE|rtsp:\/\//i;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — leak risk` : null,
      ).toBeNull();
    }
  });

  it('never touches storage keys, signed URLs, or raw media fields', () => {
    const forbidden = /storageKey|signedUrl|base64|rawPreview|errorDetail/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — media-policy risk` : null,
      ).toBeNull();
    }
  });

  it('never reaches the VLM or training/model-serving surfaces', () => {
    const forbidden =
      /VlmVerifier|PICKUP_VLM_VERIFIER|OllamaVlmVerifier|AnthropicVlmVerifier|vlm-provider|adapters\/(ollama-vlm|vlm-verifier|vlm-shared)|VlmRequestEvidence/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — out of scope` : null,
      ).toBeNull();
    }
  });
});
