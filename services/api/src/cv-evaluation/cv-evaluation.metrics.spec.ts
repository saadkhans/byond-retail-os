import { CvTestScenario, GroundTruthEventKind } from '@prisma/client';
import {
  EvalGroundTruth,
  EvalRun,
  SCORE_NOTE,
  basketDeltasEqual,
  evaluateClip,
  evaluateScenario,
  expectedBasketDelta,
  median,
  predictedBasketDelta,
  summarize,
} from './cv-evaluation.metrics';

/** Pure metric math — the entire dashboard is these functions. */

function gt(overrides: Partial<EvalGroundTruth> = {}): EvalGroundTruth {
  return {
    videoAssetId: 'asset-1',
    originalFilename: 'clip.mp4',
    eventKind: GroundTruthEventKind.PICKUP,
    testType: null,
    sku: 'WATER-500',
    quantity: 1,
    ...overrides,
  };
}

function run(overrides: {
  policy?: string;
  kind?: string | null;
  fused?: string[];
  vlm?: Partial<{
    invoked: boolean;
    status: string | null;
    verdict: string | null;
    selectedSku: string | null;
    requiresHumanReview: boolean | null;
  }>;
  stages?: { stage: string; ms: number }[];
  processingMs?: number | null;
  fusedTopScore?: number | null;
} = {}): EvalRun {
  return {
    runId: 'run-1',
    createdAt: new Date('2026-08-13T00:00:00Z'),
    policy: overrides.policy ?? 'AUTO_PROPOSE',
    fusedTopScore: overrides.fusedTopScore ?? 0.61,
    processingMs: overrides.processingMs ?? 1200,
    evidence: {
      detector: {
        events:
          overrides.kind === null
            ? []
            : [{ kind: overrides.kind ?? 'PICKUP', peakMs: 9000 }],
      },
      fused: (overrides.fused ?? ['WATER-500', 'COLA-330']).map((sku) => ({
        sku,
      })),
      vlm: {
        invoked: false,
        status: null,
        verdict: null,
        selectedSku: null,
        requiresHumanReview: null,
        ...overrides.vlm,
      },
      stages: overrides.stages ?? [
        { stage: 'ocr', ms: 300 },
        { stage: 'vlm', ms: 900 },
      ],
    },
  };
}

describe('evaluateClip', () => {
  it('no run → hasRun false, everything null/empty', () => {
    const clip = evaluateClip(gt(), null);
    expect(clip.hasRun).toBe(false);
    expect(clip.predictedSku).toBeNull();
    expect(clip.top3Skus).toEqual([]);
    expect(clip.stages).toEqual([]);
  });

  it('reads kind, fused top-3, stage timings, and processingMs defensively', () => {
    const clip = evaluateClip(
      gt(),
      run({ fused: ['A', 'B', 'C', 'D'], processingMs: 987 }),
    );
    expect(clip.predictedKind).toBe('PICKUP');
    expect(clip.top3Skus).toEqual(['A', 'B', 'C']);
    expect(clip.predictedSku).toBe('A');
    expect(clip.processingMs).toBe(987);
    expect(clip.stages).toEqual([
      { stage: 'ocr', ms: 300 },
      { stage: 'vlm', ms: 900 },
    ]);
  });

  it('a VLM MATCH overrides the fused top candidate (fusionPredictedSku rule)', () => {
    const clip = evaluateClip(
      gt(),
      run({
        fused: ['COLA-330', 'WATER-500'],
        vlm: {
          invoked: true,
          status: 'VERDICT',
          verdict: 'MATCH',
          selectedSku: 'WATER-500',
        },
      }),
    );
    expect(clip.predictedSku).toBe('WATER-500');
  });

  it('malformed evidence degrades to nulls, never throws', () => {
    const clip = evaluateClip(gt(), {
      runId: 'run-x',
      createdAt: new Date(),
      policy: 'FAILED',
      fusedTopScore: null,
      processingMs: null,
      evidence: 'not an object',
    });
    expect(clip.hasRun).toBe(true);
    expect(clip.predictedKind).toBeNull();
    expect(clip.predictedSku).toBeNull();
    expect(clip.top3Skus).toEqual([]);
  });
});

describe('median', () => {
  it('odd and even sample counts', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('evaluateScenario', () => {
  const pickupGt = gt({ testType: CvTestScenario.PICKUP_SINGLE });

  it('unlabeled clip → pass null (excluded from pass rates)', () => {
    expect(evaluateScenario(null, gt(), evaluateClip(gt(), run())).pass).toBeNull();
  });

  it('no run → pass false with the constant explanation', () => {
    const result = evaluateScenario(
      CvTestScenario.PICKUP_SINGLE,
      pickupGt,
      evaluateClip(pickupGt, null),
    );
    expect(result.pass).toBe(false);
    expect(result.actual).toBe('no fusion run');
  });

  it('PICKUP_SINGLE passes on kind+sku match, fails on wrong sku', () => {
    expect(
      evaluateScenario(
        CvTestScenario.PICKUP_SINGLE,
        pickupGt,
        evaluateClip(pickupGt, run()),
      ).pass,
    ).toBe(true);
    expect(
      evaluateScenario(
        CvTestScenario.PICKUP_SINGLE,
        pickupGt,
        evaluateClip(pickupGt, run({ fused: ['COLA-330'] })),
      ).pass,
    ).toBe(false);
  });

  it('RETURN_SINGLE requires the RETURN kind', () => {
    const returnGt = gt({
      eventKind: GroundTruthEventKind.RETURN,
      testType: CvTestScenario.RETURN_SINGLE,
    });
    expect(
      evaluateScenario(
        CvTestScenario.RETURN_SINGLE,
        returnGt,
        evaluateClip(returnGt, run({ kind: 'RETURN' })),
      ).pass,
    ).toBe(true);
    expect(
      evaluateScenario(
        CvTestScenario.RETURN_SINGLE,
        returnGt,
        evaluateClip(returnGt, run({ kind: 'PICKUP' })),
      ).pass,
    ).toBe(false);
  });

  it('FALSE_TOUCH passes on any non-AUTO_PROPOSE policy', () => {
    const noneGt = gt({
      eventKind: GroundTruthEventKind.NONE,
      sku: null,
      testType: CvTestScenario.FALSE_TOUCH,
    });
    expect(
      evaluateScenario(
        CvTestScenario.FALSE_TOUCH,
        noneGt,
        evaluateClip(noneGt, run({ policy: 'UNKNOWN_PRODUCT', kind: null })),
      ).pass,
    ).toBe(true);
    expect(
      evaluateScenario(
        CvTestScenario.FALSE_TOUCH,
        noneGt,
        evaluateClip(noneGt, run({ policy: 'AUTO_PROPOSE' })),
      ).pass,
    ).toBe(false);
  });

  it('TWO_SIMILAR/TWO_VISIBLE pass on the top candidate alone', () => {
    for (const scenario of [
      CvTestScenario.TWO_SIMILAR_PICK_ONE,
      CvTestScenario.TWO_VISIBLE_PICK_ONE,
    ]) {
      const labeled = gt({ testType: scenario });
      expect(
        evaluateScenario(scenario, labeled, evaluateClip(labeled, run())).pass,
      ).toBe(true);
      expect(
        evaluateScenario(
          scenario,
          labeled,
          evaluateClip(labeled, run({ fused: ['COLA-330', 'WATER-500'] })),
        ).pass,
      ).toBe(false);
    }
  });

  it('VLM_UNAVAILABLE requires an unavailable-class status AND review policy', () => {
    const drill = gt({ testType: CvTestScenario.VLM_UNAVAILABLE });
    const pass = evaluateClip(
      drill,
      run({
        policy: 'NEEDS_HUMAN_REVIEW',
        vlm: { invoked: true, status: 'PROVIDER_UNREACHABLE' },
      }),
    );
    expect(
      evaluateScenario(CvTestScenario.VLM_UNAVAILABLE, drill, pass).pass,
    ).toBe(true);
    const wrongStatus = evaluateClip(
      drill,
      run({
        policy: 'NEEDS_HUMAN_REVIEW',
        vlm: { invoked: true, status: 'INVALID_SKU' },
      }),
    );
    expect(
      evaluateScenario(CvTestScenario.VLM_UNAVAILABLE, drill, wrongStatus).pass,
    ).toBe(false);
    const autoDespiteFault = evaluateClip(
      drill,
      run({
        policy: 'AUTO_PROPOSE',
        vlm: { invoked: true, status: 'PROVIDER_UNREACHABLE' },
      }),
    );
    expect(
      evaluateScenario(CvTestScenario.VLM_UNAVAILABLE, drill, autoDespiteFault)
        .pass,
    ).toBe(false);
  });

  it('VLM_INVALID_SKU requires an invalid-class status AND review policy', () => {
    const drill = gt({ testType: CvTestScenario.VLM_INVALID_SKU });
    const pass = evaluateClip(
      drill,
      run({
        policy: 'NEEDS_HUMAN_REVIEW',
        vlm: { invoked: true, status: 'INVALID_SKU' },
      }),
    );
    expect(
      evaluateScenario(CvTestScenario.VLM_INVALID_SKU, drill, pass).pass,
    ).toBe(true);
    const notInvoked = evaluateClip(
      drill,
      run({ policy: 'NEEDS_HUMAN_REVIEW', vlm: { invoked: false } }),
    );
    expect(
      evaluateScenario(CvTestScenario.VLM_INVALID_SKU, drill, notInvoked).pass,
    ).toBe(false);
  });
});

describe('summarize', () => {
  it('computes every dashboard metric over a mixed fixture set', () => {
    const pairs = [
      // PICKUP correct (auto-proposed, basket exact match, VLM agrees).
      {
        gt: gt({ videoAssetId: 'a1', testType: CvTestScenario.PICKUP_SINGLE }),
        clip: evaluateClip(
          gt(),
          run({
            vlm: {
              invoked: true,
              status: 'VERDICT',
              verdict: 'MATCH',
              selectedSku: 'WATER-500',
              requiresHumanReview: false,
            },
          }),
        ),
      },
      // PICKUP incorrect sku (VLM disagrees: matched the wrong sku).
      {
        gt: gt({ videoAssetId: 'a2', testType: CvTestScenario.PICKUP_SINGLE }),
        clip: evaluateClip(
          gt(),
          run({
            fused: ['COLA-330', 'WATER-500'],
            vlm: {
              invoked: true,
              status: 'VERDICT',
              verdict: 'MATCH',
              selectedSku: 'COLA-330',
              requiresHumanReview: false,
            },
          }),
        ),
      },
      // RETURN correct — not auto-proposed (review), VLM abstained.
      {
        gt: gt({
          videoAssetId: 'a3',
          eventKind: GroundTruthEventKind.RETURN,
          testType: CvTestScenario.RETURN_SINGLE,
        }),
        clip: evaluateClip(
          gt(),
          run({
            kind: 'RETURN',
            policy: 'NEEDS_HUMAN_REVIEW',
            vlm: {
              invoked: true,
              status: 'VERDICT',
              verdict: 'AMBIGUOUS',
              requiresHumanReview: true,
            },
          }),
        ),
      },
      // NONE correctly rejected.
      {
        gt: gt({
          videoAssetId: 'a4',
          eventKind: GroundTruthEventKind.NONE,
          sku: null,
          testType: CvTestScenario.FALSE_TOUCH,
        }),
        clip: evaluateClip(
          gt({ sku: null }),
          run({ kind: null, fused: [], policy: 'UNKNOWN_PRODUCT' }),
        ),
      },
      // Ground-truthed but never run.
      {
        gt: gt({ videoAssetId: 'a5' }),
        clip: evaluateClip(gt(), null),
      },
    ];
    const summary = summarize(pairs);

    expect(summary.totals).toEqual({
      groundTruthedClips: 5,
      clipsWithRun: 4,
      clipsWithoutRun: 1,
    });
    // a1 correct, a2 wrong sku.
    expect(summary.pickupAccuracy).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(summary.returnAccuracy).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    expect(summary.falseTouchRejection).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    // sku clips with a run: a1 (top1 WATER ✓), a2 (top1 COLA ✗ but top3 ✓),
    // a3 (top1 WATER ✓).
    expect(summary.skuTop1Accuracy).toEqual({
      numerator: 2,
      denominator: 3,
      rate: 2 / 3,
    });
    expect(summary.skuTop3Accuracy).toEqual({
      numerator: 3,
      denominator: 3,
      rate: 1,
    });
    // Agreement is over ANSWERED verdicts (agree + disagree) only; the
    // abstention is reported separately, never diluting the rate.
    expect(summary.vlmAgreement).toEqual({
      agree: 1,
      disagree: 1,
      vlmAnsweredCount: 2,
      vlmAbstentionCount: 1,
      vlmAgreementRate: 0.5,
      vlmAbstentionRate: 1 / 3,
    });
    // a3 is review-flagged (policy + requiresHumanReview).
    expect(summary.humanReviewRate).toEqual({
      numerator: 1,
      denominator: 4,
      rate: 0.25,
    });
    // basket DELTAS: a1 {+1} vs {+1} ✓; a2 predicted wrong sku ✗; a3 truth
    // is RETURN {-1} but nothing was proposed (missed return) ✗; a4 {} vs
    // {} ✓. The old empty-basket representation wrongly passed a3.
    expect(summary.basketExactMatchRate).toEqual({
      numerator: 2,
      denominator: 4,
      rate: 0.5,
    });
    const stages = Object.fromEntries(
      summary.latency.map((entry) => [entry.stage, entry]),
    );
    expect(stages.ocr.samples).toBe(4);
    expect(stages.ocr.medianMs).toBe(300);
    expect(stages.total.samples).toBe(4);
    expect(stages.total.medianMs).toBe(1200);
    expect(summary.perSku).toEqual([
      { sku: 'WATER-500', clips: 3, top1Correct: 2, top1Rate: 2 / 3 },
    ]);
    const byType = Object.fromEntries(
      summary.perTestType.map((entry) => [entry.testType, entry]),
    );
    expect(byType.PICKUP_SINGLE).toEqual({
      testType: 'PICKUP_SINGLE',
      clips: 2,
      passed: 1,
      passRate: 0.5,
    });
    expect(byType.RETURN_SINGLE.passed).toBe(1);
    expect(byType.FALSE_TOUCH.passed).toBe(1);
    // a5 is unlabeled? No — a5 uses default gt() (testType null) → UNLABELED
    // with pass null; scored 0 → passRate null.
    expect(byType.UNLABELED).toEqual({
      testType: 'UNLABELED',
      clips: 1,
      passed: 0,
      passRate: null,
    });
    expect(summary.scoreNote).toBe(SCORE_NOTE);
  });

  it('empty input → zero totals and null rates (no division by zero)', () => {
    const summary = summarize([]);
    expect(summary.totals.groundTruthedClips).toBe(0);
    expect(summary.pickupAccuracy.rate).toBeNull();
    expect(summary.vlmAgreement.vlmAgreementRate).toBeNull();
    expect(summary.vlmAgreement.vlmAbstentionRate).toBeNull();
    expect(summary.latency).toEqual([]);
  });
});

describe('basket delta exact match (return deltas)', () => {
  const returnGt = (overrides: Partial<EvalGroundTruth> = {}) =>
    gt({ eventKind: GroundTruthEventKind.RETURN, ...overrides });

  it('correct return SKU (AUTO_PROPOSE RETURN) is an exact match', () => {
    const clip = evaluateClip(returnGt(), run({ kind: 'RETURN' }));
    expect(expectedBasketDelta(returnGt())).toEqual({ 'WATER-500': -1 });
    expect(predictedBasketDelta(clip)).toEqual({ 'WATER-500': -1 });
    expect(
      basketDeltasEqual(
        expectedBasketDelta(returnGt()),
        predictedBasketDelta(clip),
      ),
    ).toBe(true);
    const summary = summarize([{ gt: returnGt(), clip }]);
    expect(summary.basketExactMatchRate).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
  });

  it('a MISSED return (review policy, nothing proposed) fails exact match', () => {
    const clip = evaluateClip(
      returnGt(),
      run({ kind: 'RETURN', policy: 'NEEDS_HUMAN_REVIEW' }),
    );
    expect(predictedBasketDelta(clip)).toEqual({});
    const summary = summarize([{ gt: returnGt(), clip }]);
    expect(summary.basketExactMatchRate.numerator).toBe(0);
  });

  it('a WRONG returned SKU fails exact match', () => {
    const clip = evaluateClip(
      returnGt(),
      run({ kind: 'RETURN', fused: ['COLA-330', 'WATER-500'] }),
    );
    expect(predictedBasketDelta(clip)).toEqual({ 'COLA-330': -1 });
    const summary = summarize([{ gt: returnGt(), clip }]);
    expect(summary.basketExactMatchRate.numerator).toBe(0);
  });

  it('an arbitrary non-pickup policy never counts as return success', () => {
    const clip = evaluateClip(
      returnGt(),
      run({ kind: null, fused: [], policy: 'UNKNOWN_PRODUCT' }),
    );
    expect(predictedBasketDelta(clip)).toEqual({});
    const summary = summarize([{ gt: returnGt(), clip }]);
    expect(summary.basketExactMatchRate.numerator).toBe(0);
  });

  it('NONE truth with no auto-propose still matches (empty vs empty)', () => {
    const noneGt = gt({ eventKind: GroundTruthEventKind.NONE, sku: null });
    const clip = evaluateClip(
      noneGt,
      run({ kind: null, fused: [], policy: 'UNKNOWN_PRODUCT' }),
    );
    const summary = summarize([{ gt: noneGt, clip }]);
    expect(summary.basketExactMatchRate).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
  });

  it('pickup quantity mismatch fails (gt qty 2 vs proposed 1)', () => {
    const clip = evaluateClip(gt({ quantity: 2 }), run());
    const summary = summarize([{ gt: gt({ quantity: 2 }), clip }]);
    expect(summary.basketExactMatchRate.numerator).toBe(0);
  });
});

describe('vlm agreement over answered verdicts', () => {
  const matchClip = (selectedSku: string) =>
    evaluateClip(
      gt(),
      run({
        vlm: {
          invoked: true,
          status: 'VERDICT',
          verdict: 'MATCH',
          selectedSku,
          requiresHumanReview: false,
        },
      }),
    );
  const abstainClip = () =>
    evaluateClip(
      gt(),
      run({
        policy: 'NEEDS_HUMAN_REVIEW',
        vlm: {
          invoked: true,
          status: 'VERDICT',
          verdict: 'AMBIGUOUS',
          requiresHumanReview: true,
        },
      }),
    );
  const pair = (clip: ReturnType<typeof evaluateClip>) => ({ gt: gt(), clip });

  it('1 correct MATCH + 9 abstentions → agreement 100%, abstention 90%', () => {
    const pairs = [
      pair(matchClip('WATER-500')),
      ...Array.from({ length: 9 }, () => pair(abstainClip())),
    ];
    const summary = summarize(pairs);
    expect(summary.vlmAgreement).toEqual({
      agree: 1,
      disagree: 0,
      vlmAnsweredCount: 1,
      vlmAbstentionCount: 9,
      vlmAgreementRate: 1,
      vlmAbstentionRate: 0.9,
    });
  });

  it('1 wrong MATCH + 9 abstentions → agreement 0%, abstention 90%', () => {
    const pairs = [
      pair(matchClip('COLA-330')),
      ...Array.from({ length: 9 }, () => pair(abstainClip())),
    ];
    const summary = summarize(pairs);
    expect(summary.vlmAgreement.vlmAgreementRate).toBe(0);
    expect(summary.vlmAgreement.vlmAnsweredCount).toBe(1);
    expect(summary.vlmAgreement.vlmAbstentionRate).toBe(0.9);
  });

  it('all abstentions → agreement null with answeredCount 0, abstention 100%', () => {
    const pairs = Array.from({ length: 10 }, () => pair(abstainClip()));
    const summary = summarize(pairs);
    expect(summary.vlmAgreement.vlmAgreementRate).toBeNull();
    expect(summary.vlmAgreement.vlmAnsweredCount).toBe(0);
    expect(summary.vlmAgreement.vlmAbstentionCount).toBe(10);
    expect(summary.vlmAgreement.vlmAbstentionRate).toBe(1);
  });
});
