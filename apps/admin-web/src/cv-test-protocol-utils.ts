import { CvTestProtocolStatus, CvTestScenarioResult } from './api';

/** Phase 16 helpers — pure formatting, no data access. */

export function protocolStatusTone(
  status: CvTestProtocolStatus | string,
): string {
  if (status === 'ACTIVE') {
    return 'ok';
  }
  if (status === 'CANCELLED') {
    return 'down';
  }
  if (status === 'DRAFT') {
    return 'warn';
  }
  return '';
}

export function scenarioResultTone(
  result: CvTestScenarioResult | string,
): string {
  if (result === 'PASS') {
    return 'ok';
  }
  if (result === 'FAIL') {
    return 'down';
  }
  return 'warn';
}
