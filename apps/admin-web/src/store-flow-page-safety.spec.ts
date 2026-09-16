import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static safety pin for the Phase 26 Store flow page.
 *
 * This is the one operator surface that can move stock and take money, and it
 * is also the only place an entry credential is ever visible. Two properties
 * are pinned here because losing either would be quiet and expensive:
 *
 *   1. The credential is shown once and never kept. The page must not write it
 *      to browser storage, put it in a URL, or hold it after redemption.
 *   2. The operator is told what each autonomy level actually does, in plain
 *      words, before they can pick one.
 */
const pageSource = readFileSync(
  fileURLToPath(new URL('./pages/StoreFlowPage.tsx', import.meta.url)),
  'utf8',
);

describe('Store flow page safety', () => {
  it.each([
    ['localStorage', 'persisting a credential in browser storage'],
    ['sessionStorage', 'persisting a credential in session storage'],
    ['document.cookie', 'persisting a credential in a cookie'],
    ['tokenHash', 'rendering the stored digest'],
    ['window.location', 'putting a credential in a URL'],
  ])('never uses %s (%s)', (needle) => {
    expect(pageSource.includes(needle)).toBe(false);
  });

  it('drops the credential from memory as soon as it is redeemed', () => {
    expect(pageSource).toContain('setIssued(null)');
  });

  it('warns that the credential is shown only once', () => {
    expect(pageSource).toMatch(/will not be shown again/i);
  });

  it('explains every autonomy level before one can be chosen', () => {
    for (const level of ['SHADOW', 'PROPOSE', 'AUTO_APPLY']) {
      expect(pageSource).toContain(level);
    }
    expect(pageSource).toMatch(/changes nothing/i);
    expect(pageSource).toMatch(/waits? in the queue|approves every pickup/i);
  });

  it('says plainly that a confidence score is not a probability', () => {
    expect(pageSource).toMatch(/not a probability/i);
  });

  it('uses only the store-flow surfaces, never the raw vision review route', () => {
    expect(pageSource).toContain('/store-flow/policies');
    expect(pageSource).toContain('/store-flow/review-queue');
    expect(pageSource).not.toContain('/vision-events/');
  });
});
