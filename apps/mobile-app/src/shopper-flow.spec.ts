import { describe, expect, it } from 'vitest';
import {
  basketIsLegitimatelyEmpty,
  classifyEntryFailure,
  detectionNotice,
  ENTRY_PROBLEM_COPY,
  formatMoney,
  initialState,
  nextState,
  outcomeIsRetryable,
  OUTCOME_COPY,
  visitOutcome,
  type ShopperState,
} from './shopper-flow';
import type { Settlement, ShopperView } from './types';

/**
 * The states a real shopper hits.
 *
 * None of these assert markup. They assert what the app DECIDES: whether a
 * code that expired is distinguishable from one that was used, whether an
 * empty basket in a SHADOW store is presented as normal, whether a
 * settlement a colleague has to look at is a state or a failure, and whether
 * a lost connection is ever allowed to make a basket disappear.
 */

const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  status: 'NOT_STARTED',
  blockedBy: null,
  orderNumber: null,
  paidMinor: null,
  currencyCode: null,
  paymentStatus: null,
  ...over,
});

const view = (over: Partial<ShopperView> = {}): ShopperView => ({
  journeyId: 'journey_1',
  journeyStatus: 'OPEN',
  detection: { autonomyLevel: 'SHADOW', active: false, settlesOnExit: false },
  basket: { lines: [], totalMinor: 0, currencyCode: null, hasUnpricedLine: false },
  settlement: settlement(),
  ...over,
});

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line_1',
  sku: 'SKU-WATER',
  productName: 'Water 500ml',
  quantity: 1,
  unitPriceMinor: 120,
  lineTotalMinor: 120,
  currencyCode: 'GBP',
  ...over,
});

// ===========================================================================
// The door
// ===========================================================================

describe('a credential that will not let you in', () => {
  it('tells an EXPIRED code apart from a used one — they need different actions', () => {
    expect(
      classifyEntryFailure({
        status: 409,
        message: 'Entry credential is not usable (EXPIRED)',
      }),
    ).toBe('EXPIRED');
    expect(
      classifyEntryFailure({
        status: 409,
        message: 'Entry credential is not usable (ALREADY_USED)',
      }),
    ).toBe('ALREADY_USED');
    expect(ENTRY_PROBLEM_COPY.EXPIRED.title).not.toBe(
      ENTRY_PROBLEM_COPY.ALREADY_USED.title,
    );
  });

  it('classifies a revoked code', () => {
    expect(
      classifyEntryFailure({
        status: 409,
        message: 'Entry credential is not usable (REVOKED)',
      }),
    ).toBe('REVOKED');
  });

  it('gives unknown and wrong THE SAME answer, because the API refuses to say', () => {
    const unknown = classifyEntryFailure({
      status: 404,
      message: 'Entry credential is not valid',
    });
    const wrong = classifyEntryFailure({
      status: 404,
      message: 'Entry credential is not valid',
    });
    expect(unknown).toBe('NOT_VALID');
    expect(wrong).toBe('NOT_VALID');
    // A 401 from the same surface must not become a THIRD, distinguishable
    // story — it lands in the same bucket.
    expect(
      classifyEntryFailure({ status: 401, message: 'Shopper session is not valid' }),
    ).toBe('NOT_VALID');
  });

  it('never leaks a reason code or a status into what the shopper reads', () => {
    for (const copy of Object.values(ENTRY_PROBLEM_COPY)) {
      const text = `${copy.title} ${copy.detail}`;
      expect(text).not.toMatch(/ALREADY_USED|EXPIRED|REVOKED|4\d\d|journey|tenant/);
    }
  });

  it('reads an unreachable API as offline, not as a rejection', () => {
    expect(classifyEntryFailure({ status: 0, message: 'Cannot reach the store' })).toBe(
      'OFFLINE',
    );
  });

  it('falls back to a neutral answer for anything it does not recognise', () => {
    expect(classifyEntryFailure({ status: 500, message: 'boom' })).toBe(
      'UNAVAILABLE',
    );
    expect(
      classifyEntryFailure({ status: 409, message: 'something else entirely' }),
    ).toBe('UNAVAILABLE');
  });

  it('does not mistake a message that merely contains the letters', () => {
    expect(
      classifyEntryFailure({ status: 409, message: 'NOTEXPIREDYET' }),
    ).toBe('UNAVAILABLE');
  });
});

describe('the entry state machine', () => {
  it('starts at the door, idle and unproblematic', () => {
    expect(initialState).toEqual({ phase: 'ENTRY', busy: false, problem: null });
  });

  it('clears the previous problem while a new attempt is in flight', () => {
    const withProblem: ShopperState = {
      phase: 'ENTRY',
      busy: false,
      problem: 'EXPIRED',
    };
    expect(nextState(withProblem, { type: 'ENTER_SUBMITTED' })).toEqual({
      phase: 'ENTRY',
      busy: true,
      problem: null,
    });
  });

  it('lands in the store on success', () => {
    const state = nextState(initialState, {
      type: 'ENTER_SUCCEEDED',
      view: view(),
    });
    expect(state).toMatchObject({ phase: 'IN_STORE', stale: false });
  });

  it('returns to the door with the classified problem on failure', () => {
    const state = nextState(
      { phase: 'ENTRY', busy: true, problem: null },
      {
        type: 'ENTER_FAILED',
        failure: { status: 409, message: 'Entry credential is not usable (EXPIRED)' },
      },
    );
    expect(state).toEqual({ phase: 'ENTRY', busy: false, problem: 'EXPIRED' });
  });
});

// ===========================================================================
// The basket
// ===========================================================================

describe('an empty basket', () => {
  it('is a correct answer under SHADOW, and is said to be', () => {
    const shadow = view();
    expect(basketIsLegitimatelyEmpty(shadow)).toBe(true);
    const notice = detectionNotice(shadow.detection);
    expect(notice.title).toMatch(/not adding items automatically/i);
    expect(notice.detail).toMatch(/on purpose/i);
  });

  it('is NOT explained away as normal once detection is live', () => {
    const live = view({
      detection: { autonomyLevel: 'AUTO_APPLY', active: true, settlesOnExit: true },
    });
    expect(basketIsLegitimatelyEmpty(live)).toBe(false);
  });

  it('says a colleague confirms each item under PROPOSE', () => {
    expect(
      detectionNotice({
        autonomyLevel: 'PROPOSE',
        active: true,
        settlesOnExit: true,
      }).title,
    ).toMatch(/colleague/i);
  });

  it('never claims detection is running when it is not', () => {
    const notice = detectionNotice({
      autonomyLevel: 'SHADOW',
      active: false,
      settlesOnExit: false,
    });
    expect(`${notice.title} ${notice.detail}`).not.toMatch(
      /updates as you shop|appear here shortly/i,
    );
  });
});

describe('losing signal', () => {
  it('keeps the basket on screen and marks it stale', () => {
    const inStore = nextState(initialState, {
      type: 'ENTER_SUCCEEDED',
      view: view({
        basket: {
          lines: [line()],
          totalMinor: 120,
          currencyCode: 'GBP',
          hasUnpricedLine: false,
        },
      }),
    });
    const stale = nextState(inStore, {
      type: 'BASKET_REFRESH_FAILED',
      failure: { status: 0, message: 'Cannot reach the store' },
    });
    expect(stale).toMatchObject({ phase: 'IN_STORE', stale: true });
    expect(stale.phase === 'IN_STORE' && stale.view.basket.lines).toHaveLength(1);
  });

  it('un-stales on the next good refresh', () => {
    const stale: ShopperState = {
      phase: 'IN_STORE',
      view: view(),
      leaving: false,
      stale: true,
    };
    expect(
      nextState(stale, { type: 'BASKET_REFRESHED', view: view() }),
    ).toMatchObject({ stale: false });
  });

  it('ends the visit when the credential itself stops working', () => {
    const inStore: ShopperState = {
      phase: 'IN_STORE',
      view: view(),
      leaving: false,
      stale: false,
    };
    expect(
      nextState(inStore, {
        type: 'BASKET_REFRESH_FAILED',
        failure: { status: 401, message: 'Shopper session is not valid' },
      }),
    ).toEqual({ phase: 'ENDED', problem: 'NOT_VALID' });
  });

  it('ignores a refresh that lands after the visit is over', () => {
    const done: ShopperState = {
      phase: 'OUTCOME',
      view: view(),
      outcome: 'PAID',
    };
    expect(nextState(done, { type: 'BASKET_REFRESHED', view: view() })).toBe(done);
  });
});

// ===========================================================================
// Exit and payment
// ===========================================================================

describe('what the exit meant', () => {
  it('treats a pending review as a state, not an error, and lets the shopper re-check', () => {
    const outcome = visitOutcome(
      settlement({ status: 'BLOCKED_ON_REVIEW', blockedBy: 'AWAITING_EVENT_REVIEW' }),
    );
    expect(outcome).toBe('AWAITING_COLLEAGUE');
    expect(outcomeIsRetryable(outcome)).toBe(true);
    expect(OUTCOME_COPY.AWAITING_COLLEAGUE.tone).toBe('waiting');
    expect(OUTCOME_COPY.AWAITING_COLLEAGUE.title).toMatch(/colleague/i);
  });

  it('reads a captured payment as paid', () => {
    expect(
      visitOutcome(
        settlement({
          status: 'PAID',
          orderNumber: 'ORD-1',
          paidMinor: 240,
          currencyCode: 'GBP',
          paymentStatus: 'PAID',
        }),
      ),
    ).toBe('PAID');
  });

  it('reads an order that was never charged as "pay at the counter", never as a retry', () => {
    const outcome = visitOutcome(
      settlement({
        status: 'ORDER_CREATED',
        blockedBy: 'PAYMENT_TERMINAL',
        orderNumber: 'ORD-1',
        paymentStatus: 'UNPAID',
      }),
    );
    expect(outcome).toBe('PAY_AT_COUNTER');
    expect(outcomeIsRetryable(outcome)).toBe(false);
    expect(OUTCOME_COPY.PAY_AT_COUNTER.tone).toBe('action');
  });

  it('reads an unvalued order the same way rather than showing a zero total', () => {
    expect(
      visitOutcome(
        settlement({
          status: 'ORDER_CREATED',
          blockedBy: 'NO_ORDER_TOTAL',
          orderNumber: 'ORD-1',
        }),
      ),
    ).toBe('PAY_AT_COUNTER');
  });

  it('distinguishes "took nothing" from "this store settles at the counter"', () => {
    expect(visitOutcome(settlement({ blockedBy: 'EMPTY_BASKET' }))).toBe(
      'NOTHING_TO_PAY',
    );
    expect(visitOutcome(settlement({ blockedBy: 'SETTLEMENT_DISABLED' }))).toBe(
      'SETTLED_IN_STORE',
    );
  });

  it('asks for a person when settlement itself failed', () => {
    expect(visitOutcome(settlement({ status: 'FAILED' }))).toBe('NEEDS_HELP');
    expect(OUTCOME_COPY.NEEDS_HELP.tone).toBe('action');
  });

  it('never shows a shopper a Phase 26 reason code', () => {
    for (const copy of Object.values(OUTCOME_COPY)) {
      expect(`${copy.title} ${copy.detail}`).not.toMatch(
        /AWAITING_EVENT_REVIEW|EMPTY_BASKET|NO_ORDER_TOTAL|SETTLEMENT_DISABLED|PAYMENT_TERMINAL|BLOCKED_ON_REVIEW/,
      );
    }
  });
});

describe('the exit state machine', () => {
  const inStore: ShopperState = {
    phase: 'IN_STORE',
    view: view(),
    leaving: false,
    stale: false,
  };

  it('moves to leaving and keeps the basket for the exit screen', () => {
    expect(nextState(inStore, { type: 'EXIT_SUBMITTED' })).toMatchObject({
      phase: 'LEAVING',
      leaving: true,
    });
  });

  it('cannot be submitted twice from the leaving screen', () => {
    const leaving = nextState(inStore, { type: 'EXIT_SUBMITTED' });
    expect(nextState(leaving, { type: 'EXIT_SUBMITTED' })).toBe(leaving);
  });

  it('resolves to the outcome the settlement describes', () => {
    const leaving = nextState(inStore, { type: 'EXIT_SUBMITTED' });
    const settled = nextState(leaving, {
      type: 'EXIT_RESOLVED',
      view: view({
        journeyStatus: 'EXITED',
        settlement: settlement({
          status: 'BLOCKED_ON_REVIEW',
          blockedBy: 'AWAITING_EVENT_REVIEW',
        }),
      }),
    });
    expect(settled).toMatchObject({
      phase: 'OUTCOME',
      outcome: 'AWAITING_COLLEAGUE',
    });
  });

  it('puts the shopper back in the store when the exit itself failed, so they can retry', () => {
    const leaving = nextState(inStore, { type: 'EXIT_SUBMITTED' });
    expect(
      nextState(leaving, {
        type: 'EXIT_FAILED',
        failure: { status: 503, message: 'unavailable' },
      }),
    ).toMatchObject({ phase: 'IN_STORE', stale: true });
  });

  it('ends the visit if the credential died mid-exit', () => {
    const leaving = nextState(inStore, { type: 'EXIT_SUBMITTED' });
    expect(
      nextState(leaving, {
        type: 'EXIT_FAILED',
        failure: { status: 401, message: 'Shopper session is not valid' },
      }),
    ).toEqual({ phase: 'ENDED', problem: 'NOT_VALID' });
  });

  it('returns to the door on restart', () => {
    expect(
      nextState({ phase: 'OUTCOME', view: view(), outcome: 'PAID' }, { type: 'RESTART' }),
    ).toEqual(initialState);
  });
});

// ===========================================================================
// Money
// ===========================================================================

describe('formatMoney', () => {
  it('formats minor units in their currency', () => {
    expect(formatMoney(240, 'GBP')).toBe('GBP 2.40');
    expect(formatMoney(0, 'GBP')).toBe('GBP 0.00');
  });

  it('refuses to show an amount with no currency rather than guess one', () => {
    expect(formatMoney(240, null)).toBeNull();
    expect(formatMoney(240, undefined)).toBeNull();
  });

  it('refuses to show a missing or nonsensical amount', () => {
    expect(formatMoney(null, 'GBP')).toBeNull();
    expect(formatMoney(undefined, 'GBP')).toBeNull();
    expect(formatMoney(Number.NaN, 'GBP')).toBeNull();
  });
});
