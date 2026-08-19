import { PilotEvaluationStatus, PilotVerdict } from './api';

/** Phase 15 helpers — pure formatting, no data access. */

/** null = denominator was zero: render as unknown, never as 0%. */
export function formatAccuracy(rate: number | null): string {
  if (rate === null) {
    return '—';
  }
  return `${Math.round(rate * 1000) / 10}%`;
}

export function evaluationStatusTone(
  status: PilotEvaluationStatus | string,
): string {
  if (status === 'OPEN') {
    return 'ok';
  }
  if (status === 'CANCELLED') {
    return 'down';
  }
  return '';
}

export function verdictTone(verdict: PilotVerdict | string): string {
  if (verdict === 'CORRECT') {
    return 'ok';
  }
  if (verdict === 'UNCERTAIN') {
    return 'warn';
  }
  return 'down';
}
