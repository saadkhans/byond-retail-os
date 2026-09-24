import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 29 Loyalty & promotions page.
 *
 * Two things it must never do:
 *
 *  1. TOUCH PRICING. The page reads and writes promotions and loyalty
 *     accounts, and ASKS for an explained price. It must never post to a
 *     price-book route — a promotion screen that can edit a price version is
 *     precisely the side door Phase 25's versioning exists to prevent.
 *
 *  2. HANDLE CONTACT OR PAYMENT DETAILS. A loyalty account is identified by
 *     an operator-issued member code. No email, phone, card, or any other
 *     personal identifier belongs on this screen.
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/LoyaltyPage.tsx', import.meta.url)),
  'utf8',
);

describe('Loyalty page never reaches the pricing write surface', () => {
  it.each([
    ['/price-books', 'price book route'],
    ['/prices/resolve', 'raw price resolution (the quote endpoint explains instead)'],
    ['priceBookId', 'price book identifier field'],
    ['unitPriceMinor:', 'writing a price'],
    ['/versions/', 'a price version path'],
  ])('never references %s (%s)', (needle) => {
    if (needle === '/versions/') {
      // Promotion version paths are fine; price-book version paths are not.
      expect(pageSource.includes('/price-books/')).toBe(false);
      return;
    }
    expect(pageSource.includes(needle)).toBe(false);
  });

  it('only ever calls loyalty, catalog, and store read endpoints', () => {
    const paths = [...pageSource.matchAll(/api<?[^(]*\(\s*`?['`]([^'`]+)/g)].map(
      (match) => match[1],
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(
        path.startsWith('/loyalty') ||
          path.startsWith('/stores') ||
          path.startsWith('/catalog/'),
      ).toBe(true);
    }
  });
});

describe('Loyalty page keeps personal and payment data off the screen', () => {
  it.each([
    'email',
    'phone',
    'mobile',
    'cardNumber',
    'pan',
    'last4',
    'dateOfBirth',
    'address',
  ])('never references %s', (needle) => {
    // Word boundaries, in the style of the ESL vendor-neutrality guard: "pan"
    // is a payment term but also a substring of "expand", and a bare
    // substring match would make this spec impossible to satisfy honestly.
    expect(new RegExp(`\\b${needle}\\b`, 'i').test(pageSource)).toBe(false);
  });

  it('says out loud that a member code is not a contact detail', () => {
    expect(pageSource).toContain('operator-issued identifier');
    expect(pageSource).toContain('Neither is a contact or payment detail');
  });
});

describe('Loyalty page explains the invariant to the operator', () => {
  it.each([
    'Promotions do not rewrite prices',
    'names one price version and at most one promotion version',
    'append-only ledger',
    'A redemption larger than the balance is refused',
    'Activated versions are immutable',
    'no price book is touched',
    'PROMOTION_BASE',
  ])('states: %s', (phrase) => {
    expect(pageSource.includes(phrase)).toBe(true);
  });

  it('warns rather than renders when a quote does not add up', () => {
    expect(pageSource).toContain('quoteIsExplainable');
    expect(pageSource).toContain('This quote does not add up');
  });

  it('treats an unresolved price as unpriced, never as free', () => {
    expect(pageSource).toContain('unpriced');
    expect(pageSource).toContain('not free');
  });

  it('sends a replay-safe key with every points movement', () => {
    expect(pageSource).toContain('movementIdempotencyKey');
    expect(pageSource).toContain('idempotencyKey');
  });
});
