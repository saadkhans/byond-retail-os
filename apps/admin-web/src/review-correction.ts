/**
 * Per-event CORRECT-review form state, shared by JourneysPage and
 * ReviewQueuePage.
 *
 * The draft is one object keyed by the event it belongs to, replaced
 * WHOLE when the reviewer switches rows — reason, product, quantity, and
 * kind can never leak from one observation's form into another's audited
 * review (Codex P1: a stale reason submitted for the wrong observation
 * would be recorded immutably).
 */

export interface CorrectionDraft {
  eventId: string;
  productId: string;
  quantity: string;
  eventType: 'PRODUCT_PICKUP' | 'PRODUCT_RETURN';
  reason: string;
}

/** Fresh draft for ONE event — every field starts from that event's own
 *  observation, never from whatever another row's form held. */
export function newCorrectionDraft(
  eventId: string,
  original: {
    eventType: string;
    productId?: string | null;
    quantity?: number;
  },
): CorrectionDraft {
  return {
    eventId,
    productId: original.productId ?? '',
    quantity: String(original.quantity ?? 1),
    eventType:
      original.eventType === 'PRODUCT_RETURN'
        ? 'PRODUCT_RETURN'
        : 'PRODUCT_PICKUP',
    reason: '',
  };
}

export type CorrectionValidation =
  | { ok: true; quantity: number }
  | { ok: false; error: string };

/** The client-side gate both pages apply before POSTing a correction. */
export function validateCorrectionDraft(
  draft: CorrectionDraft,
): CorrectionValidation {
  const quantity = Number(draft.quantity.trim());
  if (
    !draft.productId ||
    draft.quantity.trim() === '' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    return {
      ok: false,
      error: 'A correction needs a product and a whole quantity 1..100.',
    };
  }
  return { ok: true, quantity };
}
