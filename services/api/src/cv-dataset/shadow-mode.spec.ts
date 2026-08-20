import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for the Phase 18 cv-dataset module, enforced
 * statically (same discipline as the pilot-evaluation guard):
 *
 * 1. The module WRITES only its own two dataset tables — improvement
 *    runs and candidate rows. The reviewed/corrected records it reads
 *    (pilot reviews, scenarios, journeys, calibration) are NEVER
 *    mutated.
 * 2. No billing/checkout/order/payment/inventory mutation, and no
 *    inventory access AT ALL (not even reads).
 * 3. No VLM access, no sampler access, no raw source/credential
 *    handling — dataset improvement is a pure read-plan-export layer.
 */
describe('cv-dataset module shadow mode', () => {
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

  it('never calls a write method on any delegate other than its own two tables', () => {
    const forbidden =
      /\b(order|orderLine|orderItem|paymentIntent|paymentEvent|checkoutSession|checkoutSessionItem|inventoryLevel|inventoryMovement|basket|basketItem|customerJourney|customerJourneyEvent|customerJourneyEventReview|liveCameraSession|cameraSource|videoAsset|product|location|pilotObservationReview|pilotEvaluationRun|pilotEvaluationSession|cvTestProtocol|cvTestProtocolScenario|cameraCalibrationProfile|cameraCalibrationZone|cameraCalibrationZoneProduct)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
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
