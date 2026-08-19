import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SHADOW-MODE guarantee for the Phase 12 camera module, enforced
 * statically:
 *
 * 1. No billing/inventory mutation — the replay runtime orchestrates the
 *    existing shadow pipeline and writes ONLY its own registry/run rows.
 * 2. No inventory access AT ALL — not even reads. The aggregate stock
 *    check lives in the journey service; this module has no business
 *    with stock.
 * 3. No VLM access — only fusion talks to the verifier (and sends
 *    crops/frames/references, never raw video). The camera module must
 *    not import a VLM adapter, the verifier port, or its DI token.
 */
describe('camera module shadow mode', () => {
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

  it('never touches inventory delegates at all (reads included)', () => {
    const forbidden = /\b(inventoryLevel|inventoryMovement)\b/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — not this module's business` : null,
      ).toBeNull();
    }
  });

  it('never writes vision events', () => {
    const forbidden = /\bvisionEvent\s*\.\s*(create|update|upsert|delete)/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      expect(source.match(forbidden)).toBeNull();
    }
  });

  it('never imports billing/checkout/payment services (Phase 13 live runtime included)', () => {
    const forbidden =
      /from\s+'[^']*(checkout|payments?|orders?)\/[^']*'|CheckoutService|OrdersService|PaymentsService/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — billing is elsewhere` : null,
      ).toBeNull();
    }
  });

  it('never reaches the VLM — no adapter import, no verifier port, no token', () => {
    const forbidden =
      /VlmVerifier|PICKUP_VLM_VERIFIER|OllamaVlmVerifier|AnthropicVlmVerifier|vlm-provider|adapters\/(ollama-vlm|vlm-verifier|vlm-shared)|VlmRequestEvidence/;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(forbidden);
      expect(
        match ? `${file} references ${match[0]} — only fusion talks to the VLM` : null,
      ).toBeNull();
    }
  });
});
