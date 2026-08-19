import { describe, expect, it } from 'vitest';
import {
  protocolStatusTone,
  scenarioResultTone,
} from './cv-test-protocol-utils';

describe('cv-test-protocol-utils', () => {
  it('protocol tones: ACTIVE ok · DRAFT warn · CANCELLED down · COMPLETED neutral', () => {
    expect(protocolStatusTone('ACTIVE')).toBe('ok');
    expect(protocolStatusTone('DRAFT')).toBe('warn');
    expect(protocolStatusTone('CANCELLED')).toBe('down');
    expect(protocolStatusTone('COMPLETED')).toBe('');
  });

  it('scenario result tones: PASS ok · FAIL down · INCONCLUSIVE warn', () => {
    expect(scenarioResultTone('PASS')).toBe('ok');
    expect(scenarioResultTone('FAIL')).toBe('down');
    expect(scenarioResultTone('INCONCLUSIVE')).toBe('warn');
  });
});
