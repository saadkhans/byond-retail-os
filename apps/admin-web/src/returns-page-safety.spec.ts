import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 27 Returns & reconciliation page.
 *
 * This surface puts stock back on shelves, sends money back to shoppers, and
 * writes stock off. Three properties are pinned because losing any of them
 * would be quiet and expensive:
 *
 *   1. It never touches a stock level. Everything it shows is a ledger
 *      movement or a decision record that cites one.
 *   2. It never asks for, shows, or stores card data.
 *   3. It tells the operator, in plain words, what each irreversible action
 *      actually does before they can take it.
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/ReturnsPage.tsx', import.meta.url)),
  'utf8',
);

describe('Returns page safety', () => {
  it.each([
    ['cardNumber'],
    ['cvv'],
    ['cvc'],
    ['pan'],
    ['instrumentLast4'],
  ])('never mentions %s', (needle) => {
    // Whole words only: "pan" must not match "<span".
    expect(pageSource).not.toMatch(new RegExp(`\\b${needle}\\b`, 'i'));
  });

  it.each([
    ['localStorage'],
    ['sessionStorage'],
    ['document.cookie'],
  ])('never persists anything itself in %s', (needle) => {
    expect(pageSource.includes(needle)).toBe(false);
  });

  it('never writes a stock level, only ever reads ledger movements', () => {
    // The page never reaches an inventory write endpoint at all: the reverse
    // flow changes stock by appending movements server-side, so a stock write
    // from here would be a second source of truth in the UI.
    expect(pageSource).not.toMatch(/inventory\/(levels|adjust|movements)/);
    // And every stock change it DOES show is shown as its ledger movement.
    expect(pageSource).toContain('movementId');
    expect(pageSource).toMatch(/Ledger movement/);
  });

  it('uses only the reverse-flow surfaces', () => {
    for (const route of ['/returns', '/cycle-counts', '/shrink-events']) {
      expect(pageSource).toContain(`'${route}`);
    }
    // Refunds go through the returns flow, which drives the payment
    // abstraction server-side. The page never pokes a payment intent itself.
    expect(pageSource).not.toContain('/payments/intents');
  });

  it('says what a cancellation actually does before it can be chosen', () => {
    expect(pageSource).toMatch(/comes back into stock and/i);
    expect(pageSource).toMatch(/only way to cancel an order that/i);
  });

  it('explains every reason a return moved no money, in words', () => {
    for (const reason of [
      'NOT_REQUESTED',
      'NO_CAPTURED_PAYMENT',
      'NO_PRICEABLE_LINES',
      'ALREADY_FULLY_REFUNDED',
    ]) {
      expect(pageSource).toContain(reason);
    }
    expect(pageSource).toMatch(/nothing to give back/i);
  });

  it('warns that a write-off removes real stock, and is not automatic', () => {
    expect(pageSource).toMatch(/removes real stock/i);
    expect(pageSource).toMatch(/not a probability/i);
    expect(pageSource).toMatch(/once per observation/i);
  });

  it('shows projection-vs-ledger drift as a platform problem, not a variance', () => {
    expect(pageSource).toMatch(/disagrees with its own ledger history/i);
    expect(pageSource).toMatch(/has NOT been corrected here/i);
  });

  it('tells the operator that a reference is what makes a retry safe', () => {
    expect(pageSource).toMatch(/replays the original return/i);
  });

  it('warns against pasting credentials into any free-text field', () => {
    // Three fields reach an append-only record: return reason, count note,
    // shrink reason. Each one says so.
    const warnings = pageSource.match(/Never paste card numbers/g) ?? [];
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});
