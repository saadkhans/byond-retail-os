import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for the one-SKU bootstrap module, enforced
 * statically (same discipline as the cv-dataset guard):
 *
 * 1. NO raw Prisma write of any kind, on ANY delegate. The two mutating
 *    flows DELEGATE to PilotEvaluationService (append-only pilot
 *    reviews) and JourneyService (shadow journeys/events) — services
 *    whose own guards pin that they never touch checkout, order,
 *    payment, or inventory tables.
 * 2. NEVER the vision-event review path: its APPROVE/OVERRIDE handling
 *    can create/update/remove CheckoutSessionLine rows for
 *    session-bound events. Bootstrap corrections must be record-only.
 * 3. No billing/checkout/order/payment surface, no raw source/credential
 *    handling, no storage-key or raw-media fields, no VLM/training
 *    surface.
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

  it('never calls a raw Prisma write method on ANY delegate', () => {
    const forbidden =
      /prisma\s*\.\s*\w+\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — raw-write ban violated` : null,
      ).toBeNull();
    }
  });

  it('never reaches the basket-affecting vision-event review surface', () => {
    const forbidden =
      /VisionEventsService|from\s+'[^']*\/vision\/[^']*'|vision-events\/.*\/review|checkoutSessionLine/i;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} references ${match[0]} — basket-mutation risk`
          : null,
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

  it('delegated writes go ONLY through the pilot-evaluation and journey services', () => {
    // Any other cross-module service import would widen the write
    // surface unnoticed — pin the allowlist.
    const serviceImport = /from\s+'\.\.\/([a-z-]+)\/[a-z-]+\.service'/g;
    const allowed = new Set([
      'pilot-evaluation',
      'journey',
      'prisma',
      'pickup-detection', // pickupSourceId + PICKUP_MIN_REFERENCE_IMAGES (read-only helpers)
    ]);
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(serviceImport)) {
        expect(
          allowed.has(match[1])
            ? null
            : `${file} imports ${match[0]} — outside the write allowlist`,
        ).toBeNull();
      }
    }
  });
});
