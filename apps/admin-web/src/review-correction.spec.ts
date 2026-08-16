import { describe, expect, it } from 'vitest';
import {
  newCorrectionDraft,
  validateCorrectionDraft,
} from './review-correction';

describe('newCorrectionDraft', () => {
  it('starts every field from the target event — reason always empty', () => {
    const draft = newCorrectionDraft('e-1', {
      eventType: 'PRODUCT_RETURN',
      productId: 'p-1',
      quantity: 3,
    });
    expect(draft).toEqual({
      eventId: 'e-1',
      productId: 'p-1',
      quantity: '3',
      eventType: 'PRODUCT_RETURN',
      reason: '',
    });
  });

  it('defaults unknown-product REVIEW_REQUIRED rows to an empty pickup', () => {
    const draft = newCorrectionDraft('e-2', { eventType: 'REVIEW_REQUIRED' });
    expect(draft).toEqual({
      eventId: 'e-2',
      productId: '',
      quantity: '1',
      eventType: 'PRODUCT_PICKUP',
      reason: '',
    });
  });

  it('a draft for another event shares nothing with the previous one', () => {
    const first = newCorrectionDraft('e-1', { eventType: 'PRODUCT_PICKUP' });
    first.reason = 'typed for e-1';
    first.productId = 'p-9';
    const second = newCorrectionDraft('e-2', { eventType: 'PRODUCT_PICKUP' });
    expect(second.reason).toBe('');
    expect(second.productId).toBe('');
  });
});

describe('validateCorrectionDraft', () => {
  const base = newCorrectionDraft('e-1', {
    eventType: 'PRODUCT_PICKUP',
    productId: 'p-1',
  });

  it('accepts a product with a whole quantity 1..100', () => {
    expect(validateCorrectionDraft({ ...base, quantity: '2' })).toEqual({
      ok: true,
      quantity: 2,
    });
  });

  it.each([
    ['missing product', { ...base, productId: '' }],
    ['empty quantity', { ...base, quantity: '  ' }],
    ['fractional quantity', { ...base, quantity: '1.5' }],
    ['zero quantity', { ...base, quantity: '0' }],
    ['over-bound quantity', { ...base, quantity: '101' }],
  ])('rejects %s', (_label, draft) => {
    const result = validateCorrectionDraft(draft);
    expect(result.ok).toBe(false);
  });
});
