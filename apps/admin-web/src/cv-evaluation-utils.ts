import { CvTestScenario, JourneyDecision, RateMetric } from './api';

/**
 * Pure presentation logic for the Phase 11 CV evaluation dashboard and
 * journey review UI — kept free of React so it is unit-testable (vitest)
 * without a DOM.
 */

/** "83% · 5/6" — or "—" when the denominator is empty. */
export function formatRate(metric: RateMetric): string {
  if (metric.rate === null) {
    return '—';
  }
  return `${Math.round(metric.rate * 100)}% · ${metric.numerator}/${metric.denominator}`;
}

/** Controlled-scenario pass/fail → badge label + tone. */
export function passBadge(pass: boolean | null): { label: string; tone: string } {
  if (pass === null) {
    return { label: 'UNLABELED', tone: 'warn' };
  }
  return pass ? { label: 'PASS', tone: 'ok' } : { label: 'FAIL', tone: 'down' };
}

export const TEST_TYPE_LABEL: Record<CvTestScenario, string> = {
  PICKUP_SINGLE: 'Water bottle pickup',
  RETURN_SINGLE: 'Water bottle return',
  FALSE_TOUCH: 'False touch / nothing removed',
  TWO_SIMILAR_PICK_ONE: 'Two similar, remove one',
  TWO_VISIBLE_PICK_ONE: 'Two visible, remove one',
  VLM_UNAVAILABLE: 'VLM unavailable',
  VLM_INVALID_SKU: 'VLM invalid/invented SKU',
};

/** Human label for a test scenario (null / unknown → "Unlabeled"). */
export function testTypeLabel(
  testType: CvTestScenario | 'UNLABELED' | string | null,
): string {
  if (!testType || testType === 'UNLABELED') {
    return 'Unlabeled';
  }
  return TEST_TYPE_LABEL[testType as CvTestScenario] ?? testType;
}

/** Journey shadow decision → badge tone. */
export function decisionTone(decision: JourneyDecision | string): string {
  return decision === 'READY_TO_SETTLE_SHADOW'
    ? 'ok'
    : decision === 'FAILED'
      ? 'down'
      : 'warn';
}
