import type { Detection, Settlement, ShopperView } from './types';

/**
 * The shopper app's state machine.
 *
 * Everything here is a pure function. The screens render this; they decide
 * nothing. That split is the point: the states a real shopper hits — a code
 * that expired while they queued, a code their friend already used, an empty
 * basket in a store that is only observing, an exit a colleague has to look
 * at first, a payment that did not go through — are all reachable from a
 * test without a browser.
 */

// ===========================================================================
// What went wrong at the door
// ===========================================================================

export type EntryProblem =
  /** The credential's short TTL ran out. Ask for a new one. */
  | 'EXPIRED'
  /** Single-use, and it has been used. */
  | 'ALREADY_USED'
  /** Cancelled before it was used. */
  | 'REVOKED'
  /**
   * Unknown or simply wrong. These are ONE case on purpose: the API refuses
   * to say which, so the app must not pretend to know either.
   */
  | 'NOT_VALID'
  /** The phone could not reach the API at all. */
  | 'OFFLINE'
  /** The API answered, but with something this app cannot interpret. */
  | 'UNAVAILABLE';

export interface FailureShape {
  /** HTTP status, or 0 when the request never arrived. */
  status: number;
  message: string;
}

/**
 * Classify an entry failure from what Phase 26 actually returns.
 *
 * Phase 26's redeem path answers 409 with a reason code embedded in the
 * message for a credential that EXISTS but cannot be used, and 404 for one
 * that is unknown OR wrong. The reason code is matched as a whole word so a
 * future message that merely mentions expiry cannot be mistaken for one.
 */
export function classifyEntryFailure(failure: FailureShape): EntryProblem {
  if (failure.status === 0) {
    return 'OFFLINE';
  }
  if (failure.status === 409) {
    if (/\bEXPIRED\b/.test(failure.message)) {
      return 'EXPIRED';
    }
    if (/\bALREADY_USED\b/.test(failure.message)) {
      return 'ALREADY_USED';
    }
    if (/\bREVOKED\b/.test(failure.message)) {
      return 'REVOKED';
    }
    return 'UNAVAILABLE';
  }
  if (failure.status === 400 || failure.status === 401 || failure.status === 404) {
    return 'NOT_VALID';
  }
  return 'UNAVAILABLE';
}

/**
 * What the shopper is told, and what they can do about it.
 *
 * No reason code, no status, no endpoint, no internal id ever reaches this
 * copy — a person standing at a door needs the next action, not a
 * diagnosis, and a diagnosis is exactly what an attacker would want.
 */
export const ENTRY_PROBLEM_COPY: Record<
  EntryProblem,
  { title: string; detail: string }
> = {
  EXPIRED: {
    title: 'That code has expired',
    detail: 'Entry codes only last a couple of minutes. Ask for a fresh one.',
  },
  ALREADY_USED: {
    title: 'That code has already been used',
    detail: 'Each code opens one visit. Ask for a new one to come in.',
  },
  REVOKED: {
    title: 'That code was cancelled',
    detail: 'Ask a colleague in the store for a new one.',
  },
  NOT_VALID: {
    title: 'That code did not work',
    detail: 'Check the code and try again, or ask for a new one.',
  },
  OFFLINE: {
    title: 'No connection',
    detail: 'We could not reach the store. Check your signal and try again.',
  },
  UNAVAILABLE: {
    title: 'We could not let you in just now',
    detail: 'Please try again, or ask a colleague in the store.',
  },
};

// ===========================================================================
// How the visit ended
// ===========================================================================

export type VisitOutcome =
  /** Paid, in full, through the simulated provider. */
  | 'PAID'
  /** Phase 26 will not settle while a person still has to look at something. */
  | 'AWAITING_COLLEAGUE'
  /** Nothing in the basket: there is nothing to pay for. */
  | 'NOTHING_TO_PAY'
  /** This store does not settle at the door; a colleague finishes it. */
  | 'SETTLED_IN_STORE'
  /** An order exists but the money did not move. Pay at the counter. */
  | 'PAY_AT_COUNTER'
  /** Settlement itself failed. A colleague has to sort it out. */
  | 'NEEDS_HELP';

/**
 * Read the outcome off the settlement Phase 26 reported.
 *
 * The order of these branches matters, and follows Phase 26's own priority:
 * a pending review outranks everything, because an unreviewed pickup must
 * never be quietly billed OR quietly dropped.
 */
export function visitOutcome(settlement: Settlement): VisitOutcome {
  if (settlement.status === 'BLOCKED_ON_REVIEW') {
    return 'AWAITING_COLLEAGUE';
  }
  if (settlement.status === 'FAILED') {
    return 'NEEDS_HELP';
  }
  if (settlement.status === 'PAID' || settlement.paymentStatus === 'PAID') {
    return 'PAID';
  }
  if (settlement.status === 'ORDER_CREATED') {
    return 'PAY_AT_COUNTER';
  }
  // NOT_STARTED. Phase 26 distinguishes "took nothing" from "this store does
  // not settle at the door", and so does the shopper's copy.
  if (settlement.blockedBy === 'EMPTY_BASKET') {
    return 'NOTHING_TO_PAY';
  }
  if (settlement.blockedBy === 'SETTLEMENT_DISABLED') {
    return 'SETTLED_IN_STORE';
  }
  return 'NOTHING_TO_PAY';
}

export const OUTCOME_COPY: Record<
  VisitOutcome,
  { title: string; detail: string; tone: 'good' | 'waiting' | 'action' }
> = {
  PAID: {
    title: 'Paid — you are all set',
    detail: 'Thanks for shopping with us. Your receipt is below.',
    tone: 'good',
  },
  AWAITING_COLLEAGUE: {
    title: 'Checking with a colleague',
    detail:
      'Someone is confirming one of the items before we finish. This takes a ' +
      'moment — please stay nearby.',
    tone: 'waiting',
  },
  NOTHING_TO_PAY: {
    title: 'Nothing to pay',
    detail: 'You are not taking anything with you. Have a good day.',
    tone: 'good',
  },
  SETTLED_IN_STORE: {
    title: 'A colleague will finish this',
    detail:
      'This store completes payment at the counter rather than at the door.',
    tone: 'action',
  },
  PAY_AT_COUNTER: {
    title: 'Please pay at the counter',
    detail:
      'Your order is ready but payment has not gone through here. Show this ' +
      'screen to a colleague.',
    tone: 'action',
  },
  NEEDS_HELP: {
    title: 'We need a colleague',
    detail:
      'Something went wrong finishing your visit. Please show this screen to ' +
      'someone in the store.',
    tone: 'action',
  },
};

/** Can the shopper usefully try the exit again from this outcome? */
export function outcomeIsRetryable(outcome: VisitOutcome): boolean {
  return outcome === 'AWAITING_COLLEAGUE';
}

// ===========================================================================
// What the store is doing with what you pick up
// ===========================================================================

export interface DetectionNotice {
  title: string;
  detail: string;
}

/**
 * The honest answer about an empty basket.
 *
 * Under the default SHADOW policy the store observes and changes nothing, so
 * the basket stays empty no matter what the shopper picks up. Implying that
 * detection is running would be a lie in both directions: it would make a
 * working store look broken, and it would make a shopper believe items were
 * being counted when they were not.
 */
export function detectionNotice(detection: Detection): DetectionNotice {
  if (!detection.active) {
    return {
      title: 'This store is not adding items automatically',
      detail:
        'The cameras are running in observation mode today, so this list ' +
        'stays empty on purpose. A colleague will check you out at the ' +
        'counter.',
    };
  }
  if (detection.autonomyLevel === 'PROPOSE') {
    return {
      title: 'A colleague confirms each item',
      detail:
        'What you pick up is sent for a quick check before it appears here, ' +
        'so the list can lag a little behind you.',
    };
  }
  return {
    title: 'Your basket updates as you shop',
    detail:
      'Items appear here shortly after you pick them up. Anything we are ' +
      'unsure about goes to a colleague instead.',
  };
}

/** Should the app tell the shopper the list may still be empty for good reason? */
export function basketIsLegitimatelyEmpty(view: ShopperView): boolean {
  return view.basket.lines.length === 0 && !view.detection.active;
}

// ===========================================================================
// The machine
// ===========================================================================

export type ShopperState =
  | { phase: 'ENTRY'; busy: boolean; problem: EntryProblem | null }
  | { phase: 'IN_STORE'; view: ShopperView; leaving: false; stale: boolean }
  | { phase: 'LEAVING'; view: ShopperView; leaving: true; stale: boolean }
  | { phase: 'OUTCOME'; view: ShopperView; outcome: VisitOutcome }
  | { phase: 'ENDED'; problem: EntryProblem };

export type ShopperEvent =
  | { type: 'ENTER_SUBMITTED' }
  | { type: 'ENTER_SUCCEEDED'; view: ShopperView }
  | { type: 'ENTER_FAILED'; failure: FailureShape }
  | { type: 'BASKET_REFRESHED'; view: ShopperView }
  | { type: 'BASKET_REFRESH_FAILED'; failure: FailureShape }
  | { type: 'EXIT_SUBMITTED' }
  | { type: 'EXIT_RESOLVED'; view: ShopperView }
  | { type: 'EXIT_FAILED'; failure: FailureShape }
  | { type: 'RESTART' };

export const initialState: ShopperState = {
  phase: 'ENTRY',
  busy: false,
  problem: null,
};

/**
 * The reducer.
 *
 * Two rules it never breaks:
 *
 *   * a 401 at ANY point ends the visit rather than retrying — the
 *     credential is the only thing that authorizes anything, and a dead
 *     credential means the app has nothing left to say;
 *   * a failed REFRESH never destroys the basket on screen. Losing a bar of
 *     signal must not make a shopper's items appear to vanish; the view is
 *     kept and marked stale.
 */
export function nextState(
  state: ShopperState,
  event: ShopperEvent,
): ShopperState {
  switch (event.type) {
    case 'ENTER_SUBMITTED':
      return state.phase === 'ENTRY'
        ? { phase: 'ENTRY', busy: true, problem: null }
        : state;

    case 'ENTER_SUCCEEDED':
      return { phase: 'IN_STORE', view: event.view, leaving: false, stale: false };

    case 'ENTER_FAILED':
      return {
        phase: 'ENTRY',
        busy: false,
        problem: classifyEntryFailure(event.failure),
      };

    case 'BASKET_REFRESHED':
      // A refresh that arrives after the shopper already tapped "leave" must
      // not pull them back into the store.
      if (state.phase === 'IN_STORE') {
        return { ...state, view: event.view, stale: false };
      }
      if (state.phase === 'LEAVING') {
        return { ...state, view: event.view, stale: false };
      }
      return state;

    case 'BASKET_REFRESH_FAILED':
      if (event.failure.status === 401) {
        return { phase: 'ENDED', problem: 'NOT_VALID' };
      }
      if (state.phase === 'IN_STORE' || state.phase === 'LEAVING') {
        return { ...state, stale: true };
      }
      return state;

    case 'EXIT_SUBMITTED':
      return state.phase === 'IN_STORE'
        ? { phase: 'LEAVING', view: state.view, leaving: true, stale: state.stale }
        : state;

    case 'EXIT_RESOLVED':
      return {
        phase: 'OUTCOME',
        view: event.view,
        outcome: visitOutcome(event.view.settlement),
      };

    case 'EXIT_FAILED':
      if (event.failure.status === 401) {
        return { phase: 'ENDED', problem: 'NOT_VALID' };
      }
      // The exit did not complete. Stay in the store with the basket intact
      // so the shopper can try again — Phase 26's exit is replay-safe, so
      // trying again is genuinely safe.
      if (state.phase === 'LEAVING') {
        return { phase: 'IN_STORE', view: state.view, leaving: false, stale: true };
      }
      return state;

    case 'RESTART':
      return initialState;

    default:
      return state;
  }
}

// ===========================================================================
// Money
// ===========================================================================

/**
 * Format a minor-unit amount.
 *
 * Returns null rather than a number when there is no currency to format it
 * in — an amount with no currency is not a price, and showing "3.60" beside
 * something a shopper is about to be charged for is worse than showing
 * nothing. Two decimal places: every currency this repository prices in is
 * a two-exponent currency, and guessing an exponent is how money goes wrong.
 */
export function formatMoney(
  minor: number | null | undefined,
  currencyCode: string | null | undefined,
): string | null {
  if (typeof minor !== 'number' || !Number.isFinite(minor) || !currencyCode) {
    return null;
  }
  const amount = (minor / 100).toFixed(2);
  return `${currencyCode} ${amount}`;
}
