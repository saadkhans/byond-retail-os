import { describe, expect, it } from 'vitest';
import {
  SPLIT_PERCENT_NOT_INTEGER,
  SPLIT_PERCENT_OUT_OF_RANGE,
  SPLIT_PERCENT_SUM,
  buildCreateRunBody,
  datasetReadinessTone,
  formatDatasetAction,
  formatDatasetWarning,
  formatSplit,
  runStatusTone,
  validateSplitPercents,
} from './cv-dataset-utils';

describe('runStatusTone', () => {
  it('maps every run status to a tone', () => {
    expect(runStatusTone('READY')).toBe('ok');
    expect(runStatusTone('EXPORTED')).toBe('ok');
    expect(runStatusTone('DRAFT')).toBe('warn');
    expect(runStatusTone('ARCHIVED')).toBe('down');
    expect(runStatusTone('SOMETHING_ELSE')).toBe('');
  });
});

describe('datasetReadinessTone', () => {
  it('maps readiness levels to tones', () => {
    expect(datasetReadinessTone('READY')).toBe('ok');
    expect(datasetReadinessTone('WARNING')).toBe('warn');
    expect(datasetReadinessTone('NOT_READY')).toBe('down');
    expect(datasetReadinessTone('UNKNOWN')).toBe('');
  });
});

describe('formatDatasetWarning', () => {
  it('labels every controlled warning', () => {
    for (const warning of [
      'SKU_IMBALANCE',
      'ACTION_IMBALANCE',
      'SPLITS_NOT_PLANNED',
      'SAME_SESSION_ACROSS_SPLITS',
      'LOW_COVERAGE_SKU_FORCED_TRAIN',
      'LOW_COVERAGE_ACTION_FORCED_TRAIN',
      'SMALL_DATASET',
    ]) {
      expect(formatDatasetWarning(warning)).not.toBe(warning);
    }
  });

  it('falls back to the raw value for unknown warnings', () => {
    expect(formatDatasetWarning('NEW_WARNING')).toBe('NEW_WARNING');
  });
});

describe('formatDatasetAction', () => {
  it('labels every controlled next action', () => {
    for (const action of [
      'COLLECT_MORE_EXAMPLES',
      'REVIEW_PENDING_EVENTS',
      'ADD_MISSED_EVENT_LABELS',
      'BALANCE_SKU_COVERAGE',
      'BALANCE_ACTION_COVERAGE',
      'RUN_MORE_PHASE16_PROTOCOLS',
      'IMPROVE_CAMERA_CALIBRATION',
      'EXPORT_DATASET_PACKAGE',
      'HOLD_BACK_TEST_SET',
      'VERIFY_CONFUSION_PAIRS',
    ]) {
      expect(formatDatasetAction(action)).not.toBe(action);
    }
  });

  it('falls back to the raw value for unknown actions', () => {
    expect(formatDatasetAction('NEW_ACTION')).toBe('NEW_ACTION');
  });
});

describe('formatSplit', () => {
  it('names the split, or Unplanned for null', () => {
    expect(formatSplit('TRAIN')).toBe('TRAIN');
    expect(formatSplit('HOLDOUT')).toBe('HOLDOUT');
    expect(formatSplit(null)).toBe('Unplanned');
  });
});

describe('validateSplitPercents', () => {
  it('accepts integers summing to 100', () => {
    expect(validateSplitPercents(70, 20, 10)).toBeNull();
    expect(validateSplitPercents(100, 0, 0)).toBeNull();
  });

  it('rejects non-integers', () => {
    expect(validateSplitPercents(70.5, 19.5, 10)).toBe(
      SPLIT_PERCENT_NOT_INTEGER,
    );
    expect(validateSplitPercents(Number.NaN, 20, 10)).toBe(
      SPLIT_PERCENT_NOT_INTEGER,
    );
  });

  it('rejects values outside 0..100', () => {
    expect(validateSplitPercents(-10, 100, 10)).toBe(
      SPLIT_PERCENT_OUT_OF_RANGE,
    );
    expect(validateSplitPercents(110, -20, 10)).toBe(
      SPLIT_PERCENT_OUT_OF_RANGE,
    );
  });

  it('rejects sums other than 100', () => {
    expect(validateSplitPercents(50, 30, 30)).toBe(SPLIT_PERCENT_SUM);
    expect(validateSplitPercents(10, 10, 10)).toBe(SPLIT_PERCENT_SUM);
  });
});

describe('buildCreateRunBody', () => {
  const baseForm = {
    name: '  First tuning set  ',
    purpose: 'SKU_CLASSIFICATION' as const,
    trainPercentText: '70',
    validationPercentText: '20',
    testPercentText: '10',
    minPerSkuText: '5',
    minPerActionText: '8',
    sourceEvaluationRunId: '',
    sourceTestProtocolId: '',
    sourceCalibrationProfileId: '',
    notes: '',
  };

  it('trims text and parses numbers', () => {
    const body = buildCreateRunBody(baseForm);
    expect(body.name).toBe('First tuning set');
    expect(body.trainSplitPercent).toBe(70);
    expect(body.validationSplitPercent).toBe(20);
    expect(body.testSplitPercent).toBe(10);
    expect(body.minReviewedExamplesPerSku).toBe(5);
    expect(body.minReviewedExamplesPerAction).toBe(8);
  });

  it('omits empty optional source ids and notes entirely', () => {
    const body = buildCreateRunBody(baseForm);
    expect('sourceEvaluationRunId' in body).toBe(false);
    expect('sourceTestProtocolId' in body).toBe(false);
    expect('sourceCalibrationProfileId' in body).toBe(false);
    expect('notes' in body).toBe(false);
  });

  it('includes trimmed optional ids and notes when provided', () => {
    const body = buildCreateRunBody({
      ...baseForm,
      sourceEvaluationRunId: ' eval1 ',
      sourceTestProtocolId: ' proto1 ',
      sourceCalibrationProfileId: ' calib1 ',
      notes: ' first pass ',
    });
    expect(body.sourceEvaluationRunId).toBe('eval1');
    expect(body.sourceTestProtocolId).toBe('proto1');
    expect(body.sourceCalibrationProfileId).toBe('calib1');
    expect(body.notes).toBe('first pass');
  });

  it('defaults blank minimums to zero', () => {
    const body = buildCreateRunBody({
      ...baseForm,
      minPerSkuText: '',
      minPerActionText: '',
    });
    expect(body.minReviewedExamplesPerSku).toBe(0);
    expect(body.minReviewedExamplesPerAction).toBe(0);
  });
});
