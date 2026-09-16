import { TrackingObservation } from '../tracking/tracking.types';
import { TriggerPolicy } from './trigger.policy';
import { TriggerPolicyConfig } from './trigger.types';

const BASE_CONFIG: TriggerPolicyConfig = {
  zoneCoverageThreshold: 0.2,
  motionRatioThreshold: 0.04,
  minDurationMs: 400,
  reArmQuietMs: 2_000,
  maxDurationMs: 15_000,
  rateLimitPerWindow: 20,
  rateLimitWindowMs: 60_000,
  exitQuietMs: 8_000,
};

const START = new Date('2026-09-16T10:00:00.000Z').getTime();

function observation(
  offsetMs: number,
  options: {
    frameIndex?: number;
    motionRatio?: number;
    zones?: { zoneCode: string; coverage: number }[];
    confidence?: number;
  } = {},
): TrackingObservation {
  const zones = options.zones ?? [];
  return {
    frameIndex: options.frameIndex ?? Math.floor(offsetMs / 200) + 1,
    capturedAt: new Date(START + offsetMs),
    motionRatio: options.motionRatio ?? 0,
    motionRegions: [],
    presence: {
      personLikely: (options.motionRatio ?? 0) > 0,
      handLikely: zones.some((zone) => zone.coverage > 0.2),
      confidence: options.confidence ?? 0,
    },
    zones: zones.map((zone) => ({
      zoneCode: zone.zoneCode,
      occupied: zone.coverage > 0,
      coverage: zone.coverage,
    })),
  };
}

/** Feeds a sequence and returns every trigger that came out. */
function run(
  policy: TriggerPolicy,
  observations: TrackingObservation[],
): ReturnType<TriggerPolicy['observe']>[] {
  return observations.map((item) => policy.observe(item));
}

describe('TriggerPolicy — zone moments', () => {
  it('emits one HAND_IN_ZONE for a sustained reach, not one per frame', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const frames = [
      observation(0, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(200, { zones: [{ zoneCode: 'A1', coverage: 0.5 }] }),
      observation(400, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(600, { zones: [{ zoneCode: 'A1', coverage: 0.7 }] }),
      observation(800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      // Withdraw: the falling edge closes and emits the moment.
      observation(1_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(1_200, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
    ];

    const emitted = run(policy, frames).flatMap((outcome) => outcome.emitted);
    const handTriggers = emitted.filter(
      (trigger) => trigger.kind === 'HAND_IN_ZONE',
    );

    expect(handTriggers).toHaveLength(1);
    expect(handTriggers[0].zoneCode).toBe('A1');
    expect(handTriggers[0].evidence.frameCount).toBe(4);
    expect(handTriggers[0].evidence.peakZoneCoverage).toBeCloseTo(0.7);
  });

  it('suppresses a single-frame flicker as BELOW_THRESHOLD', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const frames = [
      observation(0, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      // One covered frame only: duration 0ms, under the 400ms floor.
      observation(200, { zones: [{ zoneCode: 'A1', coverage: 0.9 }] }),
      observation(400, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
    ];

    const outcomes = run(policy, frames);
    const emitted = outcomes.flatMap((outcome) => outcome.emitted);
    const suppressed = outcomes.flatMap((outcome) => outcome.suppressed);

    expect(emitted.filter((t) => t.kind === 'HAND_IN_ZONE')).toHaveLength(0);
    expect(
      suppressed.filter(
        (item) => item.kind === 'HAND_IN_ZONE' && item.reason === 'BELOW_THRESHOLD',
      ),
    ).toHaveLength(1);
  });

  it('debounces a second reach inside the re-arm window', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const frames = [
      observation(0, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      // Closes and emits at 1000ms.
      observation(1_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      // Second reach well inside the 2000ms re-arm window.
      observation(1_200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(1_800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(2_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
    ];

    const outcomes = run(policy, frames);
    const emitted = outcomes
      .flatMap((outcome) => outcome.emitted)
      .filter((trigger) => trigger.kind === 'HAND_IN_ZONE');
    const debounced = outcomes
      .flatMap((outcome) => outcome.suppressed)
      .filter((item) => item.reason === 'DEBOUNCED');

    expect(emitted).toHaveLength(1);
    expect(debounced).toHaveLength(1);
  });

  it('re-arms once the zone has been quiet for long enough', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const frames = [
      observation(0, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(1_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      // Quiet past the 2000ms re-arm window before reaching again.
      observation(3_500, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(3_700, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(4_300, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(4_500, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
    ];

    const emitted = run(policy, frames)
      .flatMap((outcome) => outcome.emitted)
      .filter((trigger) => trigger.kind === 'HAND_IN_ZONE');

    expect(emitted).toHaveLength(2);
  });

  it('emits a still-open moment once it passes the duration ceiling', () => {
    const policy = new TriggerPolicy({
      ...BASE_CONFIG,
      maxDurationMs: 1_000,
    });
    const frames = [
      observation(0, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(600, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      // 1200ms open, past the 1000ms ceiling: emit without a falling edge.
      observation(1_400, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(1_600, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(1_800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
    ];

    const emitted = run(policy, frames)
      .flatMap((outcome) => outcome.emitted)
      .filter((trigger) => trigger.kind === 'HAND_IN_ZONE');

    // Exactly once: a permanently busy zone must keep producing work
    // without producing it on every single frame.
    expect(emitted).toHaveLength(1);
  });

  it('tracks zones independently', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const frames = [
      observation(0, {
        zones: [
          { zoneCode: 'A1', coverage: 0 },
          { zoneCode: 'B2', coverage: 0 },
        ],
      }),
      observation(200, {
        zones: [
          { zoneCode: 'A1', coverage: 0.6 },
          { zoneCode: 'B2', coverage: 0.6 },
        ],
      }),
      observation(800, {
        zones: [
          { zoneCode: 'A1', coverage: 0.6 },
          { zoneCode: 'B2', coverage: 0.6 },
        ],
      }),
      observation(1_000, {
        zones: [
          { zoneCode: 'A1', coverage: 0 },
          { zoneCode: 'B2', coverage: 0 },
        ],
      }),
    ];

    const emitted = run(policy, frames)
      .flatMap((outcome) => outcome.emitted)
      .filter((trigger) => trigger.kind === 'HAND_IN_ZONE');

    expect(emitted.map((trigger) => trigger.zoneCode).sort()).toEqual([
      'A1',
      'B2',
    ]);
  });
});

describe('TriggerPolicy — rate limiting', () => {
  it('suppresses emissions past the window budget and says why', () => {
    const policy = new TriggerPolicy({
      ...BASE_CONFIG,
      rateLimitPerWindow: 2,
      rateLimitWindowMs: 60_000,
      reArmQuietMs: 0,
    });

    // Six complete reach-and-withdraw cycles inside one window.
    const frames: TrackingObservation[] = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const base = cycle * 2_000;
      frames.push(
        observation(base, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
        observation(base + 200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
        observation(base + 800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
        observation(base + 1_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      );
    }

    const outcomes = run(policy, frames);
    const emitted = outcomes.flatMap((outcome) => outcome.emitted);
    const rateLimited = outcomes
      .flatMap((outcome) => outcome.suppressed)
      .filter((item) => item.reason === 'RATE_LIMITED');

    expect(emitted).toHaveLength(2);
    expect(rateLimited.length).toBeGreaterThan(0);
    // Nothing vanished: every cycle is either emitted or accounted for.
    expect(emitted.length + rateLimited.length).toBe(6);
  });

  it('lets the budget recover once the window slides past', () => {
    const policy = new TriggerPolicy({
      ...BASE_CONFIG,
      rateLimitPerWindow: 1,
      rateLimitWindowMs: 5_000,
      reArmQuietMs: 0,
    });

    const cycle = (base: number): TrackingObservation[] => [
      observation(base, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
      observation(base + 200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(base + 800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
      observation(base + 1_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
    ];

    const emitted = run(policy, [
      ...cycle(0),
      ...cycle(2_000), // inside the 5s window — suppressed
      ...cycle(20_000), // well past it — allowed again
    ]).flatMap((outcome) => outcome.emitted);

    expect(emitted).toHaveLength(2);
  });
});

describe('TriggerPolicy — scene and exit', () => {
  it('emits SHELF_CHANGE for whole-frame motion with no zone', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const emitted = run(policy, [
      observation(0, { motionRatio: 0 }),
      observation(200, { motionRatio: 0.3 }),
      observation(800, { motionRatio: 0.3 }),
      observation(1_000, { motionRatio: 0 }),
    ]).flatMap((outcome) => outcome.emitted);

    const shelf = emitted.filter((trigger) => trigger.kind === 'SHELF_CHANGE');
    expect(shelf).toHaveLength(1);
    expect(shelf[0].zoneCode).toBeUndefined();
    expect(shelf[0].evidence.peakMotionRatio).toBeCloseTo(0.3);
  });

  it('emits CUSTOMER_EXIT once after the scene goes quiet', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const emitted = run(policy, [
      observation(0, { motionRatio: 0.3 }),
      observation(1_000, { motionRatio: 0.3 }),
      observation(2_000, { motionRatio: 0 }),
      // Quiet stretch longer than exitQuietMs (8s) measured from 1000ms.
      observation(10_000, { motionRatio: 0 }),
      observation(12_000, { motionRatio: 0 }),
      observation(14_000, { motionRatio: 0 }),
    ]).flatMap((outcome) => outcome.emitted);

    expect(
      emitted.filter((trigger) => trigger.kind === 'CUSTOMER_EXIT'),
    ).toHaveLength(1);
  });

  it('does not call an empty aisle at startup an exit', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const emitted = run(policy, [
      observation(0, { motionRatio: 0 }),
      observation(10_000, { motionRatio: 0 }),
      observation(30_000, { motionRatio: 0 }),
    ]).flatMap((outcome) => outcome.emitted);

    expect(emitted).toHaveLength(0);
  });

  it('re-arms the exit after the next burst of activity', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    const emitted = run(policy, [
      observation(0, { motionRatio: 0.3 }),
      observation(10_000, { motionRatio: 0 }), // exit #1
      observation(12_000, { motionRatio: 0.3 }), // someone returns
      observation(30_000, { motionRatio: 0 }), // exit #2
    ]).flatMap((outcome) => outcome.emitted);

    expect(
      emitted.filter((trigger) => trigger.kind === 'CUSTOMER_EXIT'),
    ).toHaveLength(2);
  });
});

describe('TriggerPolicy — reset', () => {
  it('forgets an open moment so a stream gap cannot close it', () => {
    const policy = new TriggerPolicy(BASE_CONFIG);
    policy.observe(
      observation(200, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
    );
    policy.observe(
      observation(800, { zones: [{ zoneCode: 'A1', coverage: 0.6 }] }),
    );

    policy.reset();

    const outcome = policy.observe(
      observation(1_000, { zones: [{ zoneCode: 'A1', coverage: 0 }] }),
    );
    expect(outcome.emitted).toHaveLength(0);
    expect(outcome.suppressed).toHaveLength(0);
  });
});
