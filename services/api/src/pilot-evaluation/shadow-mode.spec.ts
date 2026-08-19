import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for the Phase 15 pilot-evaluation module,
 * enforced statically (same discipline as the camera module's guard):
 *
 * 1. The module WRITES only its own three pilot tables — evaluation
 *    runs, session attachments, and append-only observation reviews.
 * 2. No billing/checkout/order/payment/inventory mutation, and no
 *    inventory access AT ALL (not even reads).
 * 3. No VLM access, no sampler access, no raw source/credential
 *    handling — evaluation is a pure read-and-label layer.
 */
describe('pilot-evaluation module shadow mode', () => {
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

  it('never calls a write method on checkout/order/payment/inventory/basket/journey/camera models', () => {
    const forbidden =
      /\b(order|orderLine|orderItem|paymentIntent|paymentEvent|checkoutSession|checkoutSessionItem|inventoryLevel|inventoryMovement|basket|basketItem|customerJourney|customerJourneyEvent|customerJourneyEventReview|liveCameraSession|cameraSource|videoAsset|product|location)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — shadow mode violated` : null,
      ).toBeNull();
    }
  });

  it('never touches inventory delegates at all (reads included)', () => {
    const forbidden = /\b(inventoryLevel|inventoryMovement)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match
          ? `${file} references ${match[0]} — not this module's business`
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

  it('never references URLs, credential slots, or stream schemes', () => {
    const forbidden = /credentialRef|CAMERA_RTSP_SOURCE|rtsp:\/\//i;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — leak risk` : null,
      ).toBeNull();
    }
  });
});
