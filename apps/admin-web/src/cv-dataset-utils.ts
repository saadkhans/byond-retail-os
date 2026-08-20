import {
  CvDatasetPurpose,
  CvDatasetReadiness,
  CvDatasetRunStatus,
  CvDatasetSplit,
} from './api';

/** Phase 18 helpers — pure formatting/validation, no data access. */

export function runStatusTone(status: CvDatasetRunStatus | string): string {
  if (status === 'READY' || status === 'EXPORTED') {
    return 'ok';
  }
  if (status === 'DRAFT') {
    return 'warn';
  }
  if (status === 'ARCHIVED') {
    return 'down';
  }
  return '';
}

export function datasetReadinessTone(
  readiness: CvDatasetReadiness | string,
): 'ok' | 'warn' | 'down' | '' {
  if (readiness === 'READY') {
    return 'ok';
  }
  if (readiness === 'WARNING') {
    return 'warn';
  }
  if (readiness === 'NOT_READY') {
    return 'down';
  }
  return '';
}

const DATASET_WARNING_LABELS: Record<string, string> = {
  SKU_IMBALANCE: 'SKU coverage is imbalanced',
  ACTION_IMBALANCE: 'Action coverage is imbalanced',
  SPLITS_NOT_PLANNED: 'Splits have not been planned yet',
  SAME_SESSION_ACROSS_SPLITS:
    'Examples from one live session landed in different splits (leakage risk)',
  LOW_COVERAGE_SKU_FORCED_TRAIN:
    'A low-coverage SKU was kept in TRAIN instead of being split',
  LOW_COVERAGE_ACTION_FORCED_TRAIN:
    'A low-coverage action was kept in TRAIN instead of being split',
  SMALL_DATASET: 'The dataset is small — treat every metric with caution',
};

export function formatDatasetWarning(warning: string): string {
  return DATASET_WARNING_LABELS[warning] ?? warning;
}

const DATASET_ACTION_LABELS: Record<string, string> = {
  COLLECT_MORE_EXAMPLES: 'Collect more reviewed examples',
  REVIEW_PENDING_EVENTS: 'Review pending events',
  ADD_MISSED_EVENT_LABELS: 'Add missed-event labels',
  BALANCE_SKU_COVERAGE: 'Balance SKU coverage',
  BALANCE_ACTION_COVERAGE: 'Balance action coverage',
  RUN_MORE_PHASE16_PROTOCOLS: 'Run more Phase 16 test protocols',
  IMPROVE_CAMERA_CALIBRATION: 'Improve camera calibration',
  EXPORT_DATASET_PACKAGE: 'Export the dataset package',
  HOLD_BACK_TEST_SET: 'Hold back the test set from tuning',
  VERIFY_CONFUSION_PAIRS: 'Verify the likely confusion pairs',
};

export function formatDatasetAction(action: string): string {
  return DATASET_ACTION_LABELS[action] ?? action;
}

export function formatSplit(split: CvDatasetSplit | null): string {
  return split ?? 'Unplanned';
}

/** Controlled validation messages only — never echoes the input back. */
export const SPLIT_PERCENT_NOT_INTEGER =
  'Split percentages must be whole numbers';
export const SPLIT_PERCENT_OUT_OF_RANGE =
  'Split percentages must be between 0 and 100';
export const SPLIT_PERCENT_SUM =
  'Train, validation, and test percentages must sum to 100';

export function validateSplitPercents(
  train: number,
  validation: number,
  test: number,
): string | null {
  const parts = [train, validation, test];
  if (parts.some((part) => !Number.isInteger(part))) {
    return SPLIT_PERCENT_NOT_INTEGER;
  }
  if (parts.some((part) => part < 0 || part > 100)) {
    return SPLIT_PERCENT_OUT_OF_RANGE;
  }
  if (train + validation + test !== 100) {
    return SPLIT_PERCENT_SUM;
  }
  return null;
}

/** Create-run form values as the page holds them (numeric inputs raw). */
export interface CreateRunFormValues {
  name: string;
  purpose: CvDatasetPurpose;
  trainPercentText: string;
  validationPercentText: string;
  testPercentText: string;
  minPerSkuText: string;
  minPerActionText: string;
  sourceEvaluationRunId: string;
  sourceTestProtocolId: string;
  sourceCalibrationProfileId: string;
  notes: string;
}

export interface CreateRunBody {
  name: string;
  purpose: CvDatasetPurpose;
  trainSplitPercent: number;
  validationSplitPercent: number;
  testSplitPercent: number;
  minReviewedExamplesPerSku: number;
  minReviewedExamplesPerAction: number;
  sourceEvaluationRunId?: string;
  sourceTestProtocolId?: string;
  sourceCalibrationProfileId?: string;
  notes?: string;
}

/** Build the POST body for a new run: trims text, parses numbers, and omits
 *  empty optional source ids/notes rather than sending blanks. */
export function buildCreateRunBody(form: CreateRunFormValues): CreateRunBody {
  return {
    name: form.name.trim(),
    purpose: form.purpose,
    trainSplitPercent: Number(form.trainPercentText),
    validationSplitPercent: Number(form.validationPercentText),
    testSplitPercent: Number(form.testPercentText),
    minReviewedExamplesPerSku: Number(form.minPerSkuText) || 0,
    minReviewedExamplesPerAction: Number(form.minPerActionText) || 0,
    ...(form.sourceEvaluationRunId.trim()
      ? { sourceEvaluationRunId: form.sourceEvaluationRunId.trim() }
      : {}),
    ...(form.sourceTestProtocolId.trim()
      ? { sourceTestProtocolId: form.sourceTestProtocolId.trim() }
      : {}),
    ...(form.sourceCalibrationProfileId.trim()
      ? { sourceCalibrationProfileId: form.sourceCalibrationProfileId.trim() }
      : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
  };
}
