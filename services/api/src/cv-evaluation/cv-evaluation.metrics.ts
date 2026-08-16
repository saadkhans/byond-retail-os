import { CvTestScenario, GroundTruthEventKind } from '@prisma/client';
import { fusionPredictedSku } from '../pickup-fusion/pickup-fusion.service';

/**
 * Phase 11 CV evaluation — PURE metric math over (ground truth, latest
 * fusion shadow run) pairs. Everything here is side-effect free and
 * unit-tested directly; the service only loads rows and calls in.
 *
 * Only clips WITH saved ground truth ever enter these functions, and every
 * accuracy denominator additionally requires a fusion run to exist — a
 * clip that was never run is reported (clipsWithoutRun) but never scored.
 *
 * Fused scores are UNCALIBRATED ranking scores (see SCORE_NOTE) — they
 * order candidates; they are not probabilities.
 */

export const SCORE_NOTE = 'fused scores are uncalibrated ranking scores';

/** Hard cap on ground-truth rows one evaluation call scores — mirrors the
 *  pickup-validation SUMMARY_MAX_ROWS convention (newest rows win). */
export const EVALUATION_MAX_CLIPS = 500;

export interface EvalGroundTruth {
  videoAssetId: string;
  originalFilename: string;
  eventKind: GroundTruthEventKind;
  testType: CvTestScenario | null;
  sku: string | null;
  quantity: number;
}

export interface EvalRun {
  runId: string;
  createdAt: Date;
  policy: string;
  fusedTopScore: number | null;
  processingMs: number | null;
  /** The PickupFusionRun.evidence JSON column — untyped, parsed defensively. */
  evidence: unknown;
}

export interface ClipEvaluation {
  hasRun: boolean;
  runId: string | null;
  runCreatedAt: Date | null;
  policy: string | null;
  autoProposed: boolean;
  predictedKind: 'PICKUP' | 'RETURN' | null;
  predictedSku: string | null;
  top3Skus: string[];
  fusedTopScore: number | null;
  vlm: {
    invoked: boolean;
    status: string | null;
    verdict: string | null;
    selectedSku: string | null;
    requiresHumanReview: boolean | null;
  };
  stages: { stage: string; ms: number }[];
  processingMs: number | null;
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface EvaluationSummary {
  totals: {
    groundTruthedClips: number;
    clipsWithRun: number;
    clipsWithoutRun: number;
  };
  pickupAccuracy: RateMetric;
  returnAccuracy: RateMetric;
  falseTouchRejection: RateMetric;
  skuTop1Accuracy: RateMetric;
  skuTop3Accuracy: RateMetric;
  vlmAgreement: {
    agree: number;
    disagree: number;
    /** Answered verdicts only: agree + disagree. Abstentions (AMBIGUOUS /
     *  UNKNOWN / INVALID_INPUT) are honest non-answers and never dilute
     *  the agreement denominator — they are reported separately. */
    vlmAnsweredCount: number;
    vlmAbstentionCount: number;
    /** agree / (agree + disagree); null when nothing was answered. */
    vlmAgreementRate: number | null;
    /** abstentions / (answered + abstentions); null when the VLM never
     *  reached a verdict at all. */
    vlmAbstentionRate: number | null;
  };
  humanReviewRate: RateMetric;
  basketExactMatchRate: RateMetric;
  latency: { stage: string; medianMs: number; samples: number }[];
  perSku: { sku: string; clips: number; top1Correct: number; top1Rate: number | null }[];
  perTestType: {
    testType: CvTestScenario | 'UNLABELED';
    clips: number;
    passed: number;
    passRate: number | null;
  }[];
  confusion: ConfusionMatrix;
  scoreNote: typeof SCORE_NOTE;
}

/** Per-SKU confusion over ground-truthed clips WITH a run: rows = actual
 *  (ground-truth SKU, or NONE for no-event clips), columns = predicted
 *  (top-1 fused SKU when the run detected a product event, else NONE). */
export interface ConfusionMatrix {
  /** Catalog SKUs present in the scored clips (sorted) + 'NONE' last. */
  labels: string[];
  /** matrix[actualIndex][predictedIndex] = clip count. */
  matrix: number[][];
  samples: number;
}

export interface ScenarioEvaluation {
  /** null = unlabeled clip (excluded from pass rates). */
  pass: boolean | null;
  expected: string;
  actual: string;
}

export interface EvaluatedClip {
  gt: EvalGroundTruth;
  clip: ClipEvaluation;
}

/** Signed per-SKU basket delta: +N picked up, -N returned. */
export type BasketDelta = Record<string, number>;

/** What the ground truth says the basket DELTA of the clip is. A RETURN
 *  is a NEGATIVE delta — representing it as an empty basket would let a
 *  missed return (or a wrong returned SKU) score as an exact match. */
export function expectedBasketDelta(gt: EvalGroundTruth): BasketDelta {
  if (gt.sku === null) {
    return {};
  }
  if (gt.eventKind === GroundTruthEventKind.PICKUP) {
    return { [gt.sku]: gt.quantity };
  }
  if (gt.eventKind === GroundTruthEventKind.RETURN) {
    return { [gt.sku]: -gt.quantity };
  }
  return {};
}

/** What the run's policy actually proposes as a basket delta. Only an
 *  AUTO_PROPOSE run proposes anything; review/unknown/failed policies are
 *  non-answers and propose an empty delta (which can only exact-match a
 *  NONE ground truth — never a pickup or a return). */
export function predictedBasketDelta(clip: ClipEvaluation): BasketDelta {
  if (!clip.autoProposed || clip.predictedSku === null) {
    return {};
  }
  if (clip.predictedKind === 'PICKUP') {
    return { [clip.predictedSku]: 1 };
  }
  if (clip.predictedKind === 'RETURN') {
    return { [clip.predictedSku]: -1 };
  }
  return {};
}

/** Deep equality over signed deltas (missing key ≡ 0). */
export function basketDeltasEqual(a: BasketDelta, b: BasketDelta): boolean {
  const skus = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const sku of skus) {
    if ((a[sku] ?? 0) !== (b[sku] ?? 0)) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Defensive read of the untyped evidence JSON — a malformed or legacy
 *  row degrades to nulls, never a throw. */
export function evaluateClip(
  gt: EvalGroundTruth,
  run: EvalRun | null,
): ClipEvaluation {
  if (!run) {
    return {
      hasRun: false,
      runId: null,
      runCreatedAt: null,
      policy: null,
      autoProposed: false,
      predictedKind: null,
      predictedSku: null,
      top3Skus: [],
      fusedTopScore: null,
      vlm: {
        invoked: false,
        status: null,
        verdict: null,
        selectedSku: null,
        requiresHumanReview: null,
      },
      stages: [],
      processingMs: null,
    };
  }
  const evidence = isRecord(run.evidence) ? run.evidence : {};
  const detector = isRecord(evidence.detector) ? evidence.detector : {};
  const detectorEvents = Array.isArray(detector.events) ? detector.events : [];
  const firstEvent = isRecord(detectorEvents[0]) ? detectorEvents[0] : {};
  const rawKind = asString(firstEvent.kind);
  const predictedKind =
    rawKind === 'PICKUP' || rawKind === 'RETURN' ? rawKind : null;

  const fusedRaw = Array.isArray(evidence.fused) ? evidence.fused : [];
  const fused = fusedRaw
    .filter(isRecord)
    .map((candidate) => ({ sku: asString(candidate.sku) }))
    .filter((candidate): candidate is { sku: string } => candidate.sku !== null);

  const vlmRecord = isRecord(evidence.vlm) ? evidence.vlm : {};
  const vlm = {
    invoked: vlmRecord.invoked === true,
    status: asString(vlmRecord.status),
    verdict: asString(vlmRecord.verdict),
    selectedSku: asString(vlmRecord.selectedSku),
    requiresHumanReview:
      typeof vlmRecord.requiresHumanReview === 'boolean'
        ? vlmRecord.requiresHumanReview
        : null,
  };

  const predictedSku = fusionPredictedSku({
    vlm: {
      status: vlm.status,
      verdict: vlm.verdict,
      selectedSku: vlm.selectedSku,
      choice: asString(vlmRecord.choice),
    },
    fused,
  });

  const stagesRaw = Array.isArray(evidence.stages) ? evidence.stages : [];
  const stages = stagesRaw
    .filter(isRecord)
    .map((entry) => ({
      stage: asString(entry.stage),
      ms: typeof entry.ms === 'number' && Number.isFinite(entry.ms) ? entry.ms : null,
    }))
    .filter(
      (entry): entry is { stage: string; ms: number } =>
        entry.stage !== null && entry.ms !== null,
    );

  return {
    hasRun: true,
    runId: run.runId,
    runCreatedAt: run.createdAt,
    policy: run.policy,
    autoProposed: run.policy === 'AUTO_PROPOSE',
    predictedKind,
    predictedSku,
    top3Skus: fused.slice(0, 3).map((candidate) => candidate.sku),
    fusedTopScore: run.fusedTopScore,
    vlm,
    stages,
    processingMs:
      typeof run.processingMs === 'number' && Number.isFinite(run.processingMs)
        ? run.processingMs
        : null,
  };
}

function ratio(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
  };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const VLM_UNAVAILABLE_STATUSES = new Set([
  'UNAVAILABLE',
  'PROVIDER_UNREACHABLE',
  'TIMEOUT',
  'PROVIDER_ERROR',
]);
const VLM_INVALID_STATUSES = new Set([
  'INVALID_SKU',
  'INVALID_SCHEMA',
  'INVALID_JSON',
  'MALFORMED_RESPONSE',
]);

/** Pass/fail of one CONTROLLED scenario against ground truth. Expected/
 *  actual are short strings from a constant vocabulary plus catalog SKUs —
 *  never free text out of the evidence JSON. */
export function evaluateScenario(
  testType: CvTestScenario | null,
  gt: EvalGroundTruth,
  clip: ClipEvaluation,
): ScenarioEvaluation {
  if (testType === null) {
    return { pass: null, expected: 'no scenario label', actual: 'unscored' };
  }
  if (!clip.hasRun) {
    return {
      pass: false,
      expected: 'a fusion shadow run exists',
      actual: 'no fusion run',
    };
  }
  const detected =
    clip.predictedKind === null
      ? 'no event detected'
      : `${clip.predictedKind} ${clip.predictedSku ?? '(no sku)'}`;
  const vlmActual = `vlm ${clip.vlm.invoked ? (clip.vlm.status ?? 'unknown') : 'not invoked'} · policy ${clip.policy ?? 'none'}`;
  switch (testType) {
    case CvTestScenario.PICKUP_SINGLE:
      return {
        pass: clip.predictedKind === 'PICKUP' && clip.predictedSku === gt.sku,
        expected: `PICKUP ${gt.sku ?? '(no sku)'}`,
        actual: detected,
      };
    case CvTestScenario.RETURN_SINGLE:
      return {
        pass: clip.predictedKind === 'RETURN' && clip.predictedSku === gt.sku,
        expected: `RETURN ${gt.sku ?? '(no sku)'}`,
        actual: detected,
      };
    case CvTestScenario.FALSE_TOUCH:
      return {
        pass: clip.policy !== 'AUTO_PROPOSE',
        expected: 'no auto-proposed product',
        actual: clip.autoProposed
          ? `AUTO_PROPOSE ${clip.predictedSku ?? '(no sku)'}`
          : `policy ${clip.policy ?? 'none'}`,
      };
    case CvTestScenario.TWO_SIMILAR_PICK_ONE:
    case CvTestScenario.TWO_VISIBLE_PICK_ONE:
      return {
        pass: clip.predictedSku === gt.sku,
        expected: `top candidate ${gt.sku ?? '(no sku)'}`,
        actual: `top candidate ${clip.predictedSku ?? 'none'}`,
      };
    case CvTestScenario.VLM_UNAVAILABLE:
      return {
        pass:
          clip.vlm.invoked &&
          clip.vlm.status !== null &&
          VLM_UNAVAILABLE_STATUSES.has(clip.vlm.status) &&
          clip.policy === 'NEEDS_HUMAN_REVIEW',
        expected: 'vlm unavailable-class status · policy NEEDS_HUMAN_REVIEW',
        actual: vlmActual,
      };
    case CvTestScenario.VLM_INVALID_SKU:
      return {
        pass:
          clip.vlm.invoked &&
          clip.vlm.status !== null &&
          VLM_INVALID_STATUSES.has(clip.vlm.status) &&
          clip.policy === 'NEEDS_HUMAN_REVIEW',
        expected: 'vlm invalid-class status · policy NEEDS_HUMAN_REVIEW',
        actual: vlmActual,
      };
  }
}

/** Pure confusion-matrix builder — see ConfusionMatrix. 'NONE' is always
 *  the last label so the "nothing detected / nothing happened" cell sits
 *  in a stable corner for rendering. Only clips with a run are counted.
 *
 *  This is the FUSED TOP-1 matrix, exactly as the interface documents:
 *  the predicted column comes from the fusion ranking's first candidate
 *  (top3Skus[0]) after the event-kind gate — never from the VLM-selected
 *  SKU. A VLM MATCH that rescues a mis-ranked candidate must still show
 *  here as fusion ranking the wrong product first; a separate
 *  VLM-adjusted matrix would be a different metric and is deliberately
 *  not mixed into this one. */
export function buildConfusion(pairs: EvaluatedClip[]): ConfusionMatrix {
  const scored = pairs.filter(({ clip }) => clip.hasRun);
  const NONE = 'NONE';
  const actualOf = (gt: EvalGroundTruth) => gt.sku ?? NONE;
  const predictedOf = (clip: ClipEvaluation) =>
    clip.predictedKind !== null && clip.top3Skus.length > 0
      ? clip.top3Skus[0]
      : NONE;
  const skus = new Set<string>();
  for (const { gt, clip } of scored) {
    const actual = actualOf(gt);
    const predicted = predictedOf(clip);
    if (actual !== NONE) {
      skus.add(actual);
    }
    if (predicted !== NONE) {
      skus.add(predicted);
    }
  }
  const labels = [...skus].sort((a, b) => a.localeCompare(b)).concat(NONE);
  const index = new Map(labels.map((label, i) => [label, i]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const { gt, clip } of scored) {
    const row = index.get(actualOf(gt));
    const column = index.get(predictedOf(clip));
    if (row !== undefined && column !== undefined) {
      matrix[row][column] += 1;
    }
  }
  return { labels, matrix, samples: scored.length };
}

export function summarize(pairs: EvaluatedClip[]): EvaluationSummary {
  const withRun = pairs.filter(({ clip }) => clip.hasRun);

  const pickupClips = withRun.filter(
    ({ gt }) => gt.eventKind === GroundTruthEventKind.PICKUP,
  );
  const returnClips = withRun.filter(
    ({ gt }) => gt.eventKind === GroundTruthEventKind.RETURN,
  );
  const noneClips = withRun.filter(
    ({ gt }) => gt.eventKind === GroundTruthEventKind.NONE,
  );
  const skuClips = withRun.filter(({ gt }) => gt.sku !== null);

  const pickupCorrect = pickupClips.filter(
    ({ gt, clip }) =>
      clip.predictedKind === 'PICKUP' && clip.predictedSku === gt.sku,
  ).length;
  const returnCorrect = returnClips.filter(
    ({ gt, clip }) =>
      clip.predictedKind === 'RETURN' && clip.predictedSku === gt.sku,
  ).length;
  const rejected = noneClips.filter(
    ({ clip }) => clip.policy !== 'AUTO_PROPOSE',
  ).length;
  const top1 = skuClips.filter(
    ({ gt, clip }) => clip.top3Skus[0] === gt.sku,
  ).length;
  const top3 = skuClips.filter(({ gt, clip }) =>
    clip.top3Skus.includes(gt.sku as string),
  ).length;

  const vlmJudged = skuClips.filter(
    ({ clip }) => clip.vlm.invoked && clip.vlm.status === 'VERDICT',
  );
  let agree = 0;
  let disagree = 0;
  let abstain = 0;
  for (const { gt, clip } of vlmJudged) {
    if (clip.vlm.verdict === 'MATCH') {
      if (clip.vlm.selectedSku === gt.sku) {
        agree += 1;
      } else {
        disagree += 1;
      }
    } else {
      abstain += 1;
    }
  }

  const humanReview = withRun.filter(
    ({ clip }) =>
      clip.policy === 'NEEDS_HUMAN_REVIEW' ||
      clip.vlm.requiresHumanReview === true,
  ).length;

  const basketMatches = withRun.filter(({ gt, clip }) =>
    basketDeltasEqual(expectedBasketDelta(gt), predictedBasketDelta(clip)),
  ).length;

  const stageSamples = new Map<string, number[]>();
  for (const { clip } of withRun) {
    for (const { stage, ms } of clip.stages) {
      const samples = stageSamples.get(stage) ?? [];
      samples.push(ms);
      stageSamples.set(stage, samples);
    }
    if (clip.processingMs !== null) {
      const samples = stageSamples.get('total') ?? [];
      samples.push(clip.processingMs);
      stageSamples.set('total', samples);
    }
  }
  const latency = [...stageSamples.entries()]
    .map(([stage, samples]) => ({
      stage,
      medianMs: median(samples),
      samples: samples.length,
    }))
    .sort((a, b) => a.stage.localeCompare(b.stage));

  const perSkuMap = new Map<string, { clips: number; top1Correct: number }>();
  for (const { gt, clip } of skuClips) {
    const sku = gt.sku as string;
    const entry = perSkuMap.get(sku) ?? { clips: 0, top1Correct: 0 };
    entry.clips += 1;
    if (clip.top3Skus[0] === sku) {
      entry.top1Correct += 1;
    }
    perSkuMap.set(sku, entry);
  }
  const perSku = [...perSkuMap.entries()]
    .map(([sku, entry]) => ({
      sku,
      clips: entry.clips,
      top1Correct: entry.top1Correct,
      top1Rate: entry.clips > 0 ? entry.top1Correct / entry.clips : null,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  const perTestTypeMap = new Map<
    CvTestScenario | 'UNLABELED',
    { clips: number; passed: number; scored: number }
  >();
  for (const { gt, clip } of pairs) {
    const key = gt.testType ?? 'UNLABELED';
    const entry =
      perTestTypeMap.get(key) ?? { clips: 0, passed: 0, scored: 0 };
    entry.clips += 1;
    const { pass } = evaluateScenario(gt.testType, gt, clip);
    if (pass !== null) {
      entry.scored += 1;
      if (pass) {
        entry.passed += 1;
      }
    }
    perTestTypeMap.set(key, entry);
  }
  const perTestType = [...perTestTypeMap.entries()]
    .map(([testType, entry]) => ({
      testType,
      clips: entry.clips,
      passed: entry.passed,
      passRate: entry.scored > 0 ? entry.passed / entry.scored : null,
    }))
    .sort((a, b) => String(a.testType).localeCompare(String(b.testType)));

  return {
    totals: {
      groundTruthedClips: pairs.length,
      clipsWithRun: withRun.length,
      clipsWithoutRun: pairs.length - withRun.length,
    },
    pickupAccuracy: ratio(pickupCorrect, pickupClips.length),
    returnAccuracy: ratio(returnCorrect, returnClips.length),
    falseTouchRejection: ratio(rejected, noneClips.length),
    skuTop1Accuracy: ratio(top1, skuClips.length),
    skuTop3Accuracy: ratio(top3, skuClips.length),
    vlmAgreement: {
      agree,
      disagree,
      vlmAnsweredCount: agree + disagree,
      vlmAbstentionCount: abstain,
      vlmAgreementRate:
        agree + disagree > 0 ? agree / (agree + disagree) : null,
      vlmAbstentionRate:
        vlmJudged.length > 0 ? abstain / vlmJudged.length : null,
    },
    humanReviewRate: ratio(humanReview, withRun.length),
    basketExactMatchRate: ratio(basketMatches, withRun.length),
    latency,
    perSku,
    perTestType,
    confusion: buildConfusion(pairs),
    scoreNote: SCORE_NOTE,
  };
}
