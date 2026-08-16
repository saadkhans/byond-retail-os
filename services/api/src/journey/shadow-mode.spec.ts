import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee, enforced statically: the journey module —
 * including exit reconciliation, the final SHADOW decision, and the
 * event-review path — must never mutate checkout, orders, payments,
 * inventory, or baskets. Its only write surfaces are the two journey
 * tables, the append-only review table, and the AuditLog row that
 * commits with each review.
 *
 * A grep-level guard is deliberate (same shape as
 * pickup-fusion/shadow-mode.spec.ts): it fails the moment ANY code path
 * in this module acquires a billing/inventory write, regardless of which
 * branch a runtime test happens to exercise.
 */
describe('journey shadow mode (no billing/inventory mutation)', () => {
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
      /\b(order|orderLine|orderItem|paymentIntent|paymentEvent|paymentAuthorization|paymentCapture|checkoutSession|checkoutSessionLine|checkoutSessionItem|inventoryLevel|inventoryMovement|basket|basketItem)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — shadow mode violated` : null,
      ).toBeNull();
    }
  });

  it('never writes vision events (journeys observe; the vision review flow is elsewhere)', () => {
    const forbidden = /\bvisionEvent\s*\.\s*(create|update|upsert|delete)/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      expect(source.match(forbidden)).toBeNull();
    }
  });

  it('never updates or deletes journey events or reviews (append-only stream)', () => {
    const forbidden =
      /\bcustomerJourneyEvent(Review)?\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — append-only violated` : null,
      ).toBeNull();
    }
  });
});
