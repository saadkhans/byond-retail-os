import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee, enforced statically: the pickup-fusion module
 * (including the VLM verifier path) must never mutate checkout, orders,
 * payments, inventory, or baskets. Its only write surfaces are its own
 * evidence rows (pickupFusionRun), crop artifacts via VideoAssetsService,
 * and the reference-embedding index it owns.
 *
 * A grep-level guard is deliberate: it fails the moment ANY code path in
 * this module acquires a billing/inventory write, regardless of which
 * branch a runtime test happens to exercise.
 */
describe('pickup-fusion shadow mode (no billing/inventory mutation)', () => {
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

  it('never calls a write method on checkout/order/payment/inventory/basket models', () => {
    const forbidden =
      /\b(order|orderLine|orderItem|paymentIntent|paymentEvent|checkoutSession|checkoutSessionItem|inventoryLevel|inventoryMovement|basket|basketItem)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — shadow mode violated` : null,
      ).toBeNull();
    }
  });

  it('never writes vision events (fusion only reads the v1 baseline)', () => {
    const forbidden = /\bvisionEvent\s*\.\s*(create|update|upsert|delete)/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      expect(source.match(forbidden)).toBeNull();
    }
  });
});
