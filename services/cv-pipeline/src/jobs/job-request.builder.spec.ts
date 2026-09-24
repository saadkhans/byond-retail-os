import { Trigger } from '../trigger/trigger.types';
import {
  JobRequestContext,
  buildJobRequest,
  idempotencyKeyFor,
} from './job-request.builder';
import { findForbiddenMediaPath } from './media-policy';

const CONTEXT: JobRequestContext = {
  locationId: 'loc_1',
  unitId: 'unit_1',
  deviceId: 'dev_1',
  runId: 'run_abc',
  trackerKind: 'motion-diff',
  readsRealBytes: true,
};

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    kind: 'HAND_IN_ZONE',
    zoneCode: 'A1',
    startedAt: new Date('2026-09-16T10:00:00.000Z'),
    endedAt: new Date('2026-09-16T10:00:01.000Z'),
    startFrameIndex: 10,
    endFrameIndex: 15,
    evidence: {
      peakMotionRatio: 0.4213,
      peakZoneCoverage: 0.6789,
      peakPresenceConfidence: 0.5,
      frameCount: 6,
    },
    ...overrides,
  };
}

describe('buildJobRequest', () => {
  it('maps each trigger kind to the API job type and a priority', () => {
    const hand = buildJobRequest(trigger(), CONTEXT);
    const shelf = buildJobRequest(
      trigger({ kind: 'SHELF_CHANGE', zoneCode: undefined }),
      CONTEXT,
    );
    const exit = buildJobRequest(
      trigger({ kind: 'CUSTOMER_EXIT', zoneCode: undefined }),
      CONTEXT,
    );

    expect(hand.ok && hand.request.jobType).toBe('PRODUCT_RECOGNITION');
    expect(shelf.ok && shelf.request.jobType).toBe('SHELF_AUDIT');
    expect(exit.ok && exit.request.jobType).toBe('EXIT_RECONCILIATION');

    // An exit has a shopper waiting at a door; a shelf audit does not.
    expect(exit.ok && exit.request.priority).toBeGreaterThan(
      hand.ok ? hand.request.priority : 0,
    );
    expect(hand.ok && hand.request.priority).toBeGreaterThan(
      shelf.ok ? shelf.request.priority : 0,
    );
  });

  it('carries the store context through', () => {
    const built = buildJobRequest(trigger(), CONTEXT);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.request.locationId).toBe('loc_1');
    expect(built.request.unitId).toBe('unit_1');
    expect(built.request.deviceId).toBe('dev_1');
    expect(built.request.sourceType).toBe('VISION');
  });

  it('omits absent context rather than sending nulls', () => {
    const built = buildJobRequest(trigger(), {
      runId: 'run_abc',
      trackerKind: 'simulated',
      readsRealBytes: false,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect('locationId' in built.request).toBe(false);
    expect('unitId' in built.request).toBe(false);
    expect('deviceId' in built.request).toBe(false);
  });

  it('records whether the numbers came from real camera bytes', () => {
    const real = buildJobRequest(trigger(), CONTEXT);
    const rehearsal = buildJobRequest(trigger(), {
      ...CONTEXT,
      readsRealBytes: false,
      trackerKind: 'simulated',
    });

    const provenanceOf = (result: ReturnType<typeof buildJobRequest>) =>
      result.ok
        ? (result.request.inputDescriptor.provenance as Record<string, unknown>)
        : {};

    expect(provenanceOf(real).observedRealBytes).toBe(true);
    expect(provenanceOf(rehearsal).observedRealBytes).toBe(false);
    expect(provenanceOf(rehearsal).tier).toBe('TRACKING_TRIGGER');
  });

  it('rounds evidence to three decimals so descriptors stay stable', () => {
    const built = buildJobRequest(trigger(), CONTEXT);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const evidence = built.request.inputDescriptor.evidence as Record<
      string,
      number
    >;
    expect(evidence.peakMotionRatio).toBe(0.421);
    expect(evidence.peakZoneCoverage).toBe(0.679);
  });

  it('omits the zone code when the moment was not localised', () => {
    const built = buildJobRequest(
      trigger({ kind: 'SHELF_CHANGE', zoneCode: undefined }),
      CONTEXT,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const triggerBlock = built.request.inputDescriptor.trigger as Record<
      string,
      unknown
    >;
    expect('zoneCode' in triggerBlock).toBe(false);
  });
});

describe('buildJobRequest — the descriptor can never carry media', () => {
  it('produces a descriptor that passes the media policy', () => {
    for (const kind of ['HAND_IN_ZONE', 'SHELF_CHANGE', 'CUSTOMER_EXIT'] as const) {
      const built = buildJobRequest(trigger({ kind }), CONTEXT);
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(findForbiddenMediaPath(built.request.inputDescriptor)).toBeNull();
      }
    }
  });

  it('fails closed when a zone code is a location rather than a code', () => {
    // The only caller-influenced string in the descriptor is the zone
    // code, which comes from operator configuration. If that
    // configuration ever holds a path or a URL, the trigger is DROPPED —
    // not sanitised, because sanitising would hide the misconfiguration.
    const built = buildJobRequest(
      trigger({ zoneCode: 'rtsp://camera.local/stream1' }),
      CONTEXT,
    );
    expect(built.ok).toBe(false);
    if (built.ok) {
      return;
    }
    expect(built.reason).toBe('MEDIA_POLICY');
    expect(built.path).toBe('trigger.zoneCode');
  });

  it('fails closed on a media filename smuggled through the run id', () => {
    const built = buildJobRequest(trigger(), {
      ...CONTEXT,
      runId: 'run-from-frame.jpg',
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.path).toBe('provenance.runId');
    }
  });
});

describe('idempotencyKeyFor', () => {
  it('is a pure function of the moment, so retries replay', () => {
    const moment = trigger();
    expect(idempotencyKeyFor('run_abc', moment)).toBe(
      idempotencyKeyFor('run_abc', moment),
    );
  });

  it('separates moments by kind, zone and frame range', () => {
    const keys = new Set([
      idempotencyKeyFor('run_abc', trigger()),
      idempotencyKeyFor('run_abc', trigger({ zoneCode: 'B2' })),
      idempotencyKeyFor('run_abc', trigger({ startFrameIndex: 99 })),
      idempotencyKeyFor('run_abc', trigger({ kind: 'SHELF_CHANGE' })),
      idempotencyKeyFor('run_xyz', trigger()),
    ]);
    expect(keys.size).toBe(5);
  });

  it('names a scene-wide moment rather than leaving a gap', () => {
    expect(
      idempotencyKeyFor('run_abc', trigger({ zoneCode: undefined })),
    ).toContain('.scene.');
  });

  it('stays inside the API 100-character limit for realistic ids', () => {
    const key = idempotencyKeyFor(
      '6f665665-af33-45f1-9af3-9e3d0413d55e',
      trigger(),
    );
    expect(key.length).toBeLessThanOrEqual(100);
  });
});
