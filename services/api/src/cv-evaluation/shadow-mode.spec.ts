import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * READ-ONLY guarantee, enforced statically: the evaluation module scores
 * shadow runs against ground truth — it must never write ANYTHING.
 * Stricter than the pickup-fusion shadow spec: not just billing tables,
 * but every Prisma write verb on every delegate is forbidden here.
 */
describe('cv-evaluation shadow mode (read-only module)', () => {
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

  it('never calls any Prisma write verb', () => {
    const forbidden =
      /\bprisma\s*\.\s*\w+\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} calls ${match[0]} — read-only module violated` : null,
      ).toBeNull();
    }
  });

  it('never references checkout/order/payment/inventory delegates at all', () => {
    const forbidden =
      /\b(order|orderLine|paymentIntent|paymentEvent|checkoutSession|checkoutSessionLine|inventoryLevel|inventoryMovement)\s*\./;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      expect(source.match(forbidden)).toBeNull();
    }
  });
});
