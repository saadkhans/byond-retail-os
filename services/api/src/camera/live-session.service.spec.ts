import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CameraSourceStatus,
  CameraSourceType,
  CustomerJourneyDecision,
  LiveCameraSessionStatus,
  Prisma,
} from '@prisma/client';
import {
  LIVE_ANALYSIS_GEOMETRY,
  LIVE_FRAME_BUFFER_MAX,
  LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES,
  LiveSessionService,
  MAX_LIVE_SESSION_MS,
} from './live-session.service';

const TENANT = 'tenant-1';
const PIXELS = LIVE_ANALYSIS_GEOMETRY.width * LIVE_ANALYSIS_GEOMETRY.height * 3;

/** One scripted sampler result: a flat frame value, a failure code, or a
 *  side-effect hook the test uses to poke the row store mid-loop. */
type SampleScriptEntry =
  | { value: number; onCall?: () => void }
  | { fail: string };

/**
 * Deterministic subclass: the virtual clock advances by `clockStepMs` on
 * every sleep, so frame timestamps, window bounds, MAX_LIVE_SESSION_MS
 * auto-stop, and heartbeat staleness are all pure arithmetic. sleep
 * yields one macrotask so test code (stop endpoint) interleaves with the
 * loop exactly like the real event loop would.
 */
class TestLiveSessionService extends LiveSessionService {
  clock = new Date('2026-08-17T10:00:00.000Z').getTime();
  clockStepMs = 60_000;
  /** Real-milliseconds drain bound — small so timeout tests stay fast. */
  drainMs = 500;

  protected override now(): Date {
    return new Date(this.clock);
  }

  protected override sleep(): Promise<void> {
    this.clock += this.clockStepMs;
    return new Promise((resolve) => setImmediate(resolve));
  }

  protected override drainTimeoutMs(): number {
    return this.drainMs;
  }
}

function buildHarness(
  options: {
    source?: Record<string, unknown> | null;
    script?: SampleScriptEntry[];
    existingSession?: Record<string, unknown>;
    configured?: boolean;
    ffmpeg?: boolean;
    fusionError?: Error;
    /** In-flight simulation: runLiveWindow awaits this before resolving. */
    fusionGate?: Promise<void>;
    onFusionCall?: () => void;
    clockStepMs?: number;
    drainMs?: number;
  } = {},
) {
  const sourceRow =
    options.source === null
      ? null
      : {
          id: 'cam-1',
          tenantId: TENANT,
          locationId: 'store-1',
          unitId: null,
          shelfZone: null,
          sourceType: CameraSourceType.RTSP_SHADOW,
          status: CameraSourceStatus.ACTIVE,
          credentialRef: 'CAMERA_SECRET_SLOT_TEST',
          ...(options.source ?? {}),
        };
  const sessions: Record<string, unknown>[] = options.existingSession
    ? [options.existingSession]
    : [];
  /** Durable ADDITIVE finalization intents (Invariant E) — the stub
   *  honors the (liveSessionId, reason) unique with a P2002 like the
   *  real table, so addIntent's idempotency path is exercised. */
  const intents: {
    id: string;
    tenantId: unknown;
    liveSessionId: unknown;
    reason: unknown;
    materializedAt: Date | null;
  }[] = [];
  const fusionRuns: { id: string; evidence: unknown }[] = [];
  const journeyEvents: {
    sourceType: string;
    eventType: string;
    note: string | null;
  }[] = [];

  const activeStatuses: string[] = [
    LiveCameraSessionStatus.STARTING,
    LiveCameraSessionStatus.RUNNING,
    LiveCameraSessionStatus.STOPPING,
  ];
  const beforeCutoff = (
    value: unknown,
    cond: { lt?: Date } | null | undefined,
  ): boolean => {
    if (cond === null) {
      return value === null || value === undefined;
    }
    if (cond?.lt === undefined) {
      return true;
    }
    const at = value instanceof Date ? value.getTime() : null;
    return at !== null && at < cond.lt.getTime();
  };
  const matches = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean => {
    if (where.tenantId !== undefined && row.tenantId !== where.tenantId) {
      return false;
    }
    if (where.id !== undefined && row.id !== where.id) {
      return false;
    }
    if (
      where.cameraSourceId !== undefined &&
      row.cameraSourceId !== where.cameraSourceId
    ) {
      return false;
    }
    const status = where.status as
      | { in?: string[] }
      | string
      | undefined;
    if (typeof status === 'string' && row.status !== status) {
      return false;
    }
    if (
      status &&
      typeof status === 'object' &&
      status.in &&
      !status.in.includes(row.status as string)
    ) {
      return false;
    }
    if (
      where.leaseOwner !== undefined &&
      (row.leaseOwner ?? null) !== where.leaseOwner
    ) {
      return false;
    }
    // Honors the terminal-write CAS on the journey link: undefined skips,
    // null demands an unlinked row, a string demands that exact journey.
    if (
      where.journeyId !== undefined &&
      (row.journeyId ?? null) !== where.journeyId
    ) {
      return false;
    }
    // Honors the stale-reclaim heartbeat predicate like the database:
    // OR branches, each with heartbeatAt/startedAt lt-cutoffs.
    if (where.heartbeatAt !== undefined) {
      if (
        !beforeCutoff(
          row.heartbeatAt,
          where.heartbeatAt as { lt?: Date } | null,
        )
      ) {
        return false;
      }
    }
    if (where.startedAt !== undefined) {
      if (
        !beforeCutoff(row.startedAt, where.startedAt as { lt?: Date })
      ) {
        return false;
      }
    }
    const or = where.OR as Record<string, unknown>[] | undefined;
    if (or && !or.some((branch) => matches(row, branch))) {
      return false;
    }
    return true;
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    liveCameraSession: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const clash = sessions.find(
          (row) =>
            row.tenantId === args.data.tenantId &&
            row.cameraSourceId === args.data.cameraSourceId &&
            activeStatuses.includes(row.status as string),
        );
        if (clash) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = {
          id: `live-${sessions.length + 1}`,
          status: LiveCameraSessionStatus.STARTING,
          journeyId: null,
          startedAt: new Date('2026-08-17T10:00:00.000Z'),
          stoppedAt: null,
          heartbeatAt: null,
          lastFrameAt: null,
          framesSampled: 0,
          eventWindowsDetected: 0,
          eventWindowsProcessed: 0,
          fusionRunsCompleted: 0,
          journeyEventsCreated: 0,
          vlmInvoked: 0,
          vlmSkipped: 0,
          vlmFailed: 0,
          reviewNeeded: 0,
          decision: null,
          errorCode: null,
          eventWindows: [],
          ...args.data,
        };
        sessions.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async (args: { where: Record<string, unknown> }) => {
          const row = sessions.find((r) => matches(r, args.where));
          return row
            ? {
                ...row,
                cameraSource: sourceRow
                  ? { name: 'Live cam', sourceType: sourceRow.sourceType }
                  : null,
              }
            : null;
        },
      ),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        sessions
          .filter((r) => matches(r, args.where))
          .map((row) => ({
            ...row,
            cameraSource: { name: 'Live cam', sourceType: 'RTSP_SHADOW' },
          })),
      ),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = sessions.filter((r) => matches(r, args.where));
          for (const row of hits) {
            Object.assign(row, args.data);
          }
          return { count: hits.length };
        },
      ),
    },
    liveCameraSessionFinalizationIntent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        if (
          intents.some(
            (row) =>
              row.liveSessionId === args.data.liveSessionId &&
              row.reason === args.data.reason,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = {
          id: `intent-${intents.length + 1}`,
          tenantId: args.data.tenantId,
          liveSessionId: args.data.liveSessionId,
          reason: args.data.reason,
          materializedAt: null,
        };
        intents.push(row);
        return row;
      }),
      findMany: jest.fn(
        async (args: { where: Record<string, unknown> }) =>
          intents.filter(
            (row) =>
              row.tenantId === args.where.tenantId &&
              row.liveSessionId === args.where.liveSessionId,
          ),
      ),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = intents.filter(
            (row) =>
              row.id === args.where.id && row.tenantId === args.where.tenantId,
          );
          for (const row of hits) {
            Object.assign(row, args.data);
          }
          return { count: hits.length };
        },
      ),
    },
    pickupFusionRun: {
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const row = fusionRuns.find((r) => r.id === args.where.id);
        return row ? { evidence: row.evidence } : null;
      }),
    },
  };
  // Interactive transaction: hand the same mock back as the tx client.
  // Rollback needs no row restore here — the atomic create+link's ONLY
  // session write is its last statement, and the journey "creation" is a
  // mock call whose rollback the tests assert as no-abort/no-orphan.
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const sources = {
    requireSource: jest.fn(async () => {
      if (!sourceRow) {
        throw new NotFoundException('Camera source not found');
      }
      return sourceRow;
    }),
  };
  let scriptIndex = 0;
  const sampler = {
    // Tenant-BOUND sampler contract (Codex P1 fix 6): tenantId first.
    resolveSource: jest.fn((_tenantId: string, _ref: string) => ({
      configured: options.configured !== false,
    })),
    checkFfmpeg: jest.fn(async () => options.ffmpeg !== false),
    sampleFrame: jest.fn(async (_tenantId: string, _ref: string) => {
      const entry = options.script?.[scriptIndex];
      scriptIndex += 1;
      if (!entry) {
        return {
          ok: true as const,
          image: {
            width: LIVE_ANALYSIS_GEOMETRY.width,
            height: LIVE_ANALYSIS_GEOMETRY.height,
            rgb: Buffer.alloc(PIXELS, 40),
          },
          sampledAt: new Date(),
        };
      }
      if ('fail' in entry) {
        return { ok: false as const, code: entry.fail };
      }
      entry.onCall?.();
      return {
        ok: true as const,
        image: {
          width: LIVE_ANALYSIS_GEOMETRY.width,
          height: LIVE_ANALYSIS_GEOMETRY.height,
          rgb: Buffer.alloc(PIXELS, entry.value),
        },
        sampledAt: new Date(),
      };
    }),
  };
  const fusion = {
    runLiveWindow: jest.fn(
      async (_tenantId: string, _input: unknown) => {
        options.onFusionCall?.();
        if (options.fusionGate) {
          await options.fusionGate;
        }
        if (options.fusionError) {
          throw options.fusionError;
        }
        const id = `fusion-${fusionRuns.length + 1}`;
        fusionRuns.push({
          id,
          evidence: { vlm: { invoked: true, status: 'VERDICT' } },
        });
        return { runId: id };
      },
    ),
  };
  /** Journey decision mirrors the real fold's essential rule: any
   *  REVIEW_REQUIRED event that remains ⇒ NEEDS_EVENT_REVIEW; a clean
   *  event stream ⇒ READY_TO_SETTLE_SHADOW. */
  const journeyDecision = (): CustomerJourneyDecision =>
    journeyEvents.some((event) => event.eventType === 'REVIEW_REQUIRED')
      ? CustomerJourneyDecision.NEEDS_EVENT_REVIEW
      : CustomerJourneyDecision.READY_TO_SETTLE_SHADOW;
  const journeys = {
    create: jest.fn(async () => ({ id: 'journey-1' })),
    // The ATOMIC startup path (Codex P1): journey creation runs on the
    // caller's transaction so the session link commits with it or both
    // roll back.
    openJourneyInTransaction: jest.fn(async () => ({
      journeyId: 'journey-1',
    })),
    exit: jest.fn(async () => ({
      id: 'journey-1',
      decision: journeyDecision(),
      events: journeyEvents,
      issues: journeyEvents.filter(
        (event) => event.eventType === 'REVIEW_REQUIRED',
      ),
    })),
    abortShadowJourney: jest.fn(async () => ({
      id: 'journey-1',
      decision: CustomerJourneyDecision.FAILED,
    })),
    appendEvent: jest.fn(
      async (
        _tenantId: string,
        _journeyId: string,
        input: { eventType: string; sourceType?: string; note?: string },
      ) => {
        journeyEvents.push({
          sourceType: input.sourceType ?? 'MANUAL',
          eventType: input.eventType,
          note: input.note ?? null,
        });
        return {
          id: 'journey-1',
          decision: null,
          events: journeyEvents,
          issues: [],
        };
      },
    ),
    appendFromLiveFusionRun: jest.fn(async () => {
      journeyEvents.push({
        sourceType: 'LIVE_SHADOW',
        eventType: 'PRODUCT_PICKUP',
        note: null,
      });
      return {
        id: 'journey-1',
        decision: null,
        events: journeyEvents,
        issues: [],
      };
    }),
    detail: jest.fn(async () => ({
      id: 'journey-1',
      decision: journeyDecision(),
      events: journeyEvents,
      issues: [],
    })),
  };
  const service = new TestLiveSessionService(
    prisma as never,
    sources as never,
    sampler as never,
    fusion as never,
    journeys as never,
  );
  if (options.clockStepMs !== undefined) {
    service.clockStepMs = options.clockStepMs;
  }
  if (options.drainMs !== undefined) {
    service.drainMs = options.drainMs;
  }
  return {
    service,
    prisma,
    sources,
    sampler,
    fusion,
    journeys,
    sessions,
    intents,
    journeyEvents,
  };
}

async function startAndFinish(
  harness: ReturnType<typeof buildHarness>,
): Promise<void> {
  const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
  await harness.service.awaitLoop(view.sessionId);
}

describe('LiveSessionService — start', () => {
  it('creates one RUNNING session with its journey anchored to the session start', async () => {
    const harness = buildHarness({ script: [{ value: 40 }] });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.RUNNING);
    expect(view.journeyId).toBe('journey-1');
    // ATOMIC create+link: the journey opens on the startup transaction.
    expect(harness.journeys.openJourneyInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      { locationId: 'store-1', unitId: null },
      'user-1',
      { entryAt: new Date('2026-08-17T10:00:00.000Z') },
    );
    expect(harness.prisma.$transaction).toHaveBeenCalled();
    await harness.service.awaitLoop(view.sessionId);
  });

  it('duplicate start returns the EXISTING active session — no second row, no second journey', async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-existing',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        journeyId: 'journey-existing',
        startedAt: new Date('2026-08-17T09:59:00.000Z'),
        // Fresh heartbeat relative to the virtual clock — an active
        // session that must NOT be treated as a crash leftover.
        heartbeatAt: new Date('2026-08-17T10:00:00.000Z'),
        eventWindows: [],
      },
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).toBe('live-existing');
    expect(harness.prisma.liveCameraSession.create).not.toHaveBeenCalled();
    expect(harness.journeys.openJourneyInTransaction).not.toHaveBeenCalled();
  });

  it('a P2002 race on the one-active-per-source unique returns the winner', async () => {
    const harness = buildHarness();
    // Pre-check sees nothing; the create then collides with a session the
    // stub store already holds (simulating the concurrent winner).
    harness.prisma.liveCameraSession.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'live-winner',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        journeyId: 'journey-w',
        eventWindows: [],
        cameraSource: { name: 'Live cam', sourceType: 'RTSP_SHADOW' },
      });
    harness.sessions.push({
      id: 'live-winner',
      tenantId: TENANT,
      cameraSourceId: 'cam-1',
      status: LiveCameraSessionStatus.RUNNING,
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).toBe('live-winner');
  });

  it.each([
    [
      'non-RTSP_SHADOW source',
      { sourceType: CameraSourceType.FILE_REPLAY },
      /RTSP_SHADOW/,
    ],
    [
      'inactive source',
      { status: CameraSourceStatus.DISABLED },
      /not ACTIVE/,
    ],
    [
      'source without a credential slot',
      { credentialRef: null },
      /credential slot/,
    ],
  ])('rejects a %s with a controlled 409', async (_label, source, message) => {
    const harness = buildHarness({ source });
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(message);
    expect(harness.prisma.liveCameraSession.create).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured runtime source with RTSP_SOURCE_NOT_CONFIGURED', async () => {
    const harness = buildHarness({ configured: false });
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(/RTSP_SOURCE_NOT_CONFIGURED/);
  });

  it('rejects a missing ffmpeg with RTSP_UNSUPPORTED_IN_ENV', async () => {
    const harness = buildHarness({ ffmpeg: false });
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(/RTSP_UNSUPPORTED_IN_ENV/);
  });

  it('a journey-creation failure AFTER the row exists rolls the journey back and finalizes ERROR — no orphans', async () => {
    const harness = buildHarness();
    harness.journeys.openJourneyInTransaction.mockRejectedValueOnce(
      new Error('boom rtsp://user:secret@host'),
    );
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(ConflictException);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(row.errorCode).toBe('STAGE_FAILED');
    expect(row.journeyId).toBeNull();
    // The journey creation rolled back with the transaction — there is
    // nothing to abort, nothing OPEN and unlinked.
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
    // Raw exception text never persists.
    expect(JSON.stringify(row)).not.toContain('rtsp');
    expect(JSON.stringify(row)).not.toContain('secret');
  });
});

describe('LiveSessionService — sampling loop', () => {
  it('samples frames, detects a closed motion window, and drives fusion + journey import with the EXACT run id', async () => {
    const harness = buildHarness({
      // flat, burst, burst, flat → one closed window; then flats until
      // the MAX_LIVE_SESSION_MS auto-stop (clock steps 60s per sample).
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.framesSampled).toBeGreaterThanOrEqual(4);
    expect(row.eventWindowsDetected).toBe(1);
    expect(row.eventWindowsProcessed).toBe(1);
    expect(row.fusionRunsCompleted).toBe(1);
    expect(harness.fusion.runLiveWindow).toHaveBeenCalledTimes(1);
    const callInput = harness.fusion.runLiveWindow.mock.calls[0][1] as {
      liveSessionId: string;
      frames: { timestampMs: number }[];
      window: { startMs: number; endMs: number };
    };
    expect(callInput.liveSessionId).toBe('live-1');
    expect(callInput.frames.length).toBeGreaterThan(0);
    for (const frame of callInput.frames) {
      expect(frame.timestampMs).toBeLessThanOrEqual(
        callInput.window.endMs + 60_000,
      );
    }
    expect(harness.journeys.appendFromLiveFusionRun).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'fusion-1',
      'user-1',
      expect.objectContaining({
        sourceTimeBase: new Date('2026-08-17T10:00:00.000Z'),
      }),
    );
    expect(row.journeyEventsCreated).toBe(1);
    expect(row.vlmInvoked).toBe(1);
    expect(row.vlmFailed).toBe(0);
    // Auto-stop finalized the session normally with a decision snapshot.
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(row.decision).toBe(CustomerJourneyDecision.READY_TO_SETTLE_SHADOW);
  });

  it('the cooldown watermark never reprocesses the same physical window', async () => {
    const harness = buildHarness({
      script: [
        { value: 40 },
        { value: 200 },
        { value: 40 },
        { value: 40 },
        { value: 40 },
        { value: 40 },
      ],
    });
    await startAndFinish(harness);
    // The burst stays inside the rolling buffer for every later
    // iteration, yet fusion ran exactly once.
    expect(harness.fusion.runLiveWindow).toHaveBeenCalledTimes(1);
  });

  it('zero motion → zero fusion runs, clean STOPPED session', async () => {
    const harness = buildHarness({ script: [{ value: 40 }] });
    await startAndFinish(harness);
    expect(harness.fusion.runLiveWindow).not.toHaveBeenCalled();
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.STOPPED);
  });

  it('the rolling buffer is bounded', async () => {
    expect(LIVE_FRAME_BUFFER_MAX).toBe(120);
    // 15 auto-stop iterations at the test clock step can never exceed the
    // bound, so the invariant is structural here; the constant itself is
    // pinned for the runtime.
  });

  it('consecutive sampler failures finalize ERROR with the sampler code — and only the code', async () => {
    const harness = buildHarness({
      script: Array.from(
        { length: LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES },
        () => ({ fail: 'RTSP_CONNECT_FAILED' }),
      ),
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(row.errorCode).toBe('RTSP_CONNECT_FAILED');
    expect(row.decision).toBe(CustomerJourneyDecision.FAILED);
    expect(harness.journeys.abortShadowJourney).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'RTSP_CONNECT_FAILED',
      'user-1',
      expect.anything(),
    );
  });

  it('a DETECTED window whose fusion fails FAILS CLOSED: durable code, review-required journey, never READY (Codex P1)', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionError: new Error('ffmpeg said rtsp://user:secret@host broke'),
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(row.eventWindowsProcessed).toBe(0);
    // Durable controlled code — the lost interaction is visible.
    expect(row.errorCode).toBe('LIVE_WINDOW_PROCESS_FAILED');
    // The journey was marked review-required BEFORE the exit, so the
    // decision can never be READY_TO_SETTLE_SHADOW over a dropped window.
    expect(harness.journeys.appendEvent).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      expect.objectContaining({
        eventType: 'REVIEW_REQUIRED',
        note: 'LIVE_WINDOW_PROCESS_FAILED',
        sourceType: 'LIVE_SHADOW',
      }),
      'user-1',
    );
    expect(row.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(JSON.stringify(row)).not.toContain('rtsp://');
  });

  it('a DETECTED window whose journey import fails also fails closed (Codex P1)', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
    });
    harness.journeys.appendFromLiveFusionRun.mockRejectedValueOnce(
      new Error('transient import failure'),
    );
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.errorCode).toBe('LIVE_WINDOW_PROCESS_FAILED');
    expect(row.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(row.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('a lost lease stops the loop with NO finalization of its own', async () => {
    const harness = buildHarness({
      script: [
        { value: 40 },
        {
          value: 40,
          onCall: () => {
            // A takeover changes the owner mid-loop.
            harness.sessions[0].leaseOwner = 'someone-else';
          },
        },
      ],
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    await harness.service.awaitLoop(view.sessionId);
    // The loop noticed the foreign owner and left the row alone.
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.RUNNING);
    expect(harness.journeys.exit).not.toHaveBeenCalled();
  });

  it('the session auto-stops at the MVP bound', async () => {
    expect(MAX_LIVE_SESSION_MS).toBe(15 * 60_000);
    const harness = buildHarness({ script: [{ value: 40 }] });
    await startAndFinish(harness);
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.STOPPED);
  });
});

describe('LiveSessionService — stop', () => {
  it('stops a RUNNING session: journey exited, decision snapshot, STOPPED', async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-1',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        journeyId: 'journey-1',
        // Lease RELEASED — a truly dead/unowned row. (A HELD lease with a
        // fresh heartbeat now means a remote owner and is NOT finalized
        // here — pinned separately below.)
        leaseOwner: null,
        startedAt: new Date(),
        eventWindows: [],
      },
    });
    const view = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(view.decision).toBe(CustomerJourneyDecision.READY_TO_SETTLE_SHADOW);
    expect(harness.journeys.exit).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'user-1',
      expect.anything(),
    );
  });

  it('stop is idempotent on terminal sessions', async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-1',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.STOPPED,
        journeyId: 'journey-1',
        stoppedAt: new Date(),
        startedAt: new Date(),
        eventWindows: [],
      },
    });
    const view = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(harness.journeys.exit).not.toHaveBeenCalled();
  });

  it('an already-exited journey does not break the stop (decision read back)', async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-1',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        journeyId: 'journey-1',
        startedAt: new Date(),
        eventWindows: [],
      },
    });
    harness.journeys.exit.mockRejectedValueOnce(
      new ConflictException('Journey is no longer open'),
    );
    const view = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(view.decision).toBe(CustomerJourneyDecision.READY_TO_SETTLE_SHADOW);
  });
});

describe('LiveSessionService — tenant isolation and redaction', () => {
  it("tenant A cannot read or stop tenant B's session", async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-1',
        tenantId: 'tenant-B',
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        startedAt: new Date(),
        eventWindows: [],
      },
    });
    await expect(harness.service.byId(TENANT, 'live-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      harness.service.stop(TENANT, 'live-1', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('every session query carries the tenant predicate', async () => {
    const harness = buildHarness({ script: [{ value: 40 }] });
    await startAndFinish(harness);
    for (const call of harness.prisma.liveCameraSession.findFirst.mock.calls) {
      expect(call[0].where.tenantId).toBe(TENANT);
    }
    for (const call of harness.prisma.liveCameraSession.updateMany.mock
      .calls) {
      expect(call[0].where.tenantId).toBe(TENANT);
    }
  });

  it('views never contain credential or URL material', async () => {
    const harness = buildHarness({ script: [{ value: 40 }] });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(JSON.stringify(view)).not.toContain('CAMERA_SECRET_SLOT');
    expect(JSON.stringify(view)).not.toContain('rtsp');
    await harness.service.awaitLoop(view.sessionId);
  });
});

/** Poll the stub row store until a condition holds (loop interleaving). */
async function until(
  condition: () => boolean,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('LiveSessionService — atomic journey create + link (Codex P1 fix 1)', () => {
  it('a stop() racing BEFORE journey creation means NO journey is ever created', async () => {
    const harness = buildHarness();
    const originalCreate =
      harness.prisma.liveCameraSession.create.getMockImplementation() as (
        args: unknown,
      ) => Promise<Record<string, unknown>>;
    harness.prisma.liveCameraSession.create.mockImplementationOnce(
      async (args: unknown) => {
        const row = await originalCreate(args);
        // A stop endpoint finalizes the STARTING row before the atomic
        // transaction's guard read runs.
        Object.assign(row, {
          status: LiveCameraSessionStatus.STOPPED,
          stoppedAt: new Date(),
          leaseOwner: null,
        });
        return row;
      },
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(view.journeyId).toBeNull();
    // The guard refused BEFORE any journey existed.
    expect(harness.journeys.openJourneyInTransaction).not.toHaveBeenCalled();
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
    expect(harness.fusion.runLiveWindow).not.toHaveBeenCalled();
  });

  it('a stop() racing DURING the atomic create+link ROLLS BACK the journey — never OPEN and detached', async () => {
    const harness = buildHarness();
    harness.journeys.openJourneyInTransaction.mockImplementationOnce(
      async () => {
        // The stop endpoint finalized the STARTING row while the journey
        // was being created inside the transaction.
        Object.assign(harness.sessions[0], {
          status: LiveCameraSessionStatus.STOPPED,
          stoppedAt: new Date(),
          leaseOwner: null,
        });
        return { journeyId: 'journey-race' };
      },
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    // The link write missed → the WHOLE transaction (journey included)
    // rolled back: nothing OPEN, nothing to abort, nothing linked.
    expect(view.journeyId).toBeNull();
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
    expect(harness.fusion.runLiveWindow).not.toHaveBeenCalled();
  });

  it('a link/update failure rolls the journey creation back and finalizes the bare row as ERROR', async () => {
    const harness = buildHarness();
    const original =
      harness.prisma.liveCameraSession.updateMany.getMockImplementation() as (
        args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        },
      ) => Promise<{ count: number }>;
    harness.prisma.liveCameraSession.updateMany.mockImplementation(
      async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (args.data.journeyId !== undefined) {
          throw new Error('link write outage');
        }
        return original(args);
      },
    );
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(ConflictException);
    const row = harness.sessions[0];
    // No OPEN journey with no session link survives a failed startup.
    expect(row.journeyId).toBeNull();
    expect(row.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
  });

  it('a retry start after a failed startup does not inherit an orphan', async () => {
    const harness = buildHarness({ script: [{ value: 40 }] });
    harness.journeys.openJourneyInTransaction.mockRejectedValueOnce(
      new Error('transient'),
    );
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(ConflictException);
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.ERROR);
    // The retry starts a FRESH session with a FRESH journey — the failed
    // attempt left nothing behind to inherit.
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).not.toBe(harness.sessions[0].id);
    expect(view.status).toBe(LiveCameraSessionStatus.RUNNING);
    expect(view.journeyId).toBe('journey-1');
    await harness.service.awaitLoop(view.sessionId);
  });

  it('a stop() racing between the atomic link and the promote finalizes the LINKED journey through the finalizer', async () => {
    const harness = buildHarness();
    const original =
      harness.prisma.liveCameraSession.updateMany.getMockImplementation() as (
        args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        },
      ) => Promise<{ count: number }>;
    harness.prisma.liveCameraSession.updateMany.mockImplementation(
      async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (args.data.status === LiveCameraSessionStatus.RUNNING) {
          // A stop endpoint marked the row STOPPING after the link
          // committed but before the promote — the promote must miss.
          harness.sessions[0].status = LiveCameraSessionStatus.STOPPING;
        }
        return original(args);
      },
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    // The journey exists and IS linked — the finalizer closed it, so the
    // session is terminal, never a linked journey left OPEN.
    expect(view.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(view.errorCode).toBe('LIVE_SESSION_STOPPED_DURING_START');
    expect(harness.journeys.abortShadowJourney).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'LIVE_SESSION_STOPPED_DURING_START',
      'user-1',
      expect.anything(),
    );
    // The durable startup intent landed before finalization.
    expect(
      harness.intents.some(
        (intent) => intent.reason === 'STARTUP_FINALIZATION_REQUIRED',
      ),
    ).toBe(true);
    expect(harness.fusion.runLiveWindow).not.toHaveBeenCalled();
  });
});

describe('LiveSessionService — stale reclaim on start (Codex P1 fix 2)', () => {
  const STALE_SESSION = {
    id: 'live-stale',
    tenantId: TENANT,
    cameraSourceId: 'cam-1',
    journeyId: 'journey-stale',
    leaseOwner: 'dead-process',
    startedAt: new Date('2026-08-17T09:00:00.000Z'),
    heartbeatAt: new Date('2026-08-17T09:30:00.000Z'),
    eventWindows: [],
  };

  it.each([
    ['RUNNING', LiveCameraSessionStatus.RUNNING],
    ['STARTING', LiveCameraSessionStatus.STARTING],
  ])(
    'a stale %s row without a loop is reclaimed, its journey closed, and a NEW session starts',
    async (_label, status) => {
      const harness = buildHarness({
        script: [{ value: 40 }],
        existingSession: { ...STALE_SESSION, status },
      });
      const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
      const stale = harness.sessions[0];
      expect(stale.status).toBe(LiveCameraSessionStatus.ERROR);
      expect(stale.errorCode).toBe('LIVE_SESSION_STALE_RECLAIMED');
      expect(harness.journeys.abortShadowJourney).toHaveBeenCalledWith(
        TENANT,
        'journey-stale',
        'LIVE_SESSION_STALE_RECLAIMED',
        'user-1',
        expect.anything(),
      );
      // The fresh session started normally.
      expect(view.sessionId).not.toBe('live-stale');
      expect(view.status).toBe(LiveCameraSessionStatus.RUNNING);
      await harness.service.awaitLoop(view.sessionId);
    },
  );

  it('a FRESH-heartbeat row without a local loop is NOT reclaimed', async () => {
    const harness = buildHarness({
      existingSession: {
        ...STALE_SESSION,
        status: LiveCameraSessionStatus.RUNNING,
        // Heartbeat right at the virtual clock start — fresh.
        heartbeatAt: new Date('2026-08-17T10:00:00.000Z'),
      },
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).toBe('live-stale');
    expect(view.status).toBe(LiveCameraSessionStatus.RUNNING);
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
  });

  it('losing the reclaim race returns the row as it is now', async () => {
    const harness = buildHarness({
      existingSession: {
        ...STALE_SESSION,
        status: LiveCameraSessionStatus.RUNNING,
      },
    });
    harness.prisma.liveCameraSession.updateMany.mockImplementationOnce(
      async () => ({ count: 0 }),
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).toBe('live-stale');
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
  });

  it('a reclaim whose journey abort fails stays STOPPING and stop() retries it', async () => {
    const harness = buildHarness({
      existingSession: {
        ...STALE_SESSION,
        status: LiveCameraSessionStatus.RUNNING,
      },
    });
    harness.journeys.abortShadowJourney.mockRejectedValueOnce(
      new Error('transient'),
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).toBe('live-stale');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(view.errorCode).toBe('LIVE_SESSION_STALE_RECLAIMED');
    // Retry entry: stop() re-runs the abort (abort-intent code) and only
    // then terminalizes.
    const retried = await harness.service.stop(TENANT, 'live-stale', 'user-1');
    expect(retried.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(retried.errorCode).toBe('LIVE_SESSION_STALE_RECLAIMED');
    expect(retried.decision).toBe(CustomerJourneyDecision.FAILED);
  });
});

describe('LiveSessionService — retryable finalization (Codex P1 fix 3)', () => {
  it('a transient exit failure leaves STOPPING + JOURNEY_FINALIZE_RETRY; retry stop completes', async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-1',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        journeyId: 'journey-1',
        startedAt: new Date(),
        eventWindows: [],
      },
    });
    harness.journeys.exit.mockRejectedValueOnce(
      new Error('transient db outage rtsp://user:secret@host'),
    );
    const first = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(first.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(first.errorCode).toBe('JOURNEY_FINALIZE_RETRY');
    // The park recorded its durable retry intent (Invariant F).
    expect(
      harness.intents.some(
        (intent) => intent.reason === 'JOURNEY_FINALIZATION_RETRY_REQUIRED',
      ),
    ).toBe(true);
    expect(JSON.stringify(harness.sessions[0])).not.toContain('secret');
    // Retry finishes the closure and only then terminalizes. A session
    // that ever needed a finalization retry carries an intent — the
    // decision guard forbids READY (Invariant D).
    const second = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(second.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(second.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(second.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(harness.journeys.exit).toHaveBeenCalledTimes(2);
  });

  it('a transient abort failure keeps the ORIGINAL code non-terminal; retry re-aborts', async () => {
    const harness = buildHarness({
      script: Array.from(
        { length: LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES },
        () => ({ fail: 'RTSP_CONNECT_FAILED' }),
      ),
    });
    harness.journeys.abortShadowJourney.mockRejectedValueOnce(
      new Error('transient'),
    );
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(row.errorCode).toBe('RTSP_CONNECT_FAILED');
    const retried = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(retried.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(retried.errorCode).toBe('RTSP_CONNECT_FAILED');
    expect(retried.decision).toBe(CustomerJourneyDecision.FAILED);
  });
});

describe('LiveSessionService — stop drains in-flight windows (Codex P1 fix 4)', () => {
  it('stop WAITS for in-flight window processing; counters persist before STOPPED', async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let fusionStarted = false;
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionGate: gate,
      onFusionCall: () => {
        fusionStarted = true;
      },
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    await until(() => fusionStarted);
    // Stop while the window is mid-fusion; the promise resolves only
    // after the drain completes.
    const stopPromise = harness.service.stop(TENANT, view.sessionId, 'user-1');
    releaseGate();
    const stopped = await stopPromise;
    expect(stopped.status).toBe(LiveCameraSessionStatus.STOPPED);
    // The drained window landed BEFORE the terminal state.
    expect(stopped.eventWindowsProcessed).toBe(1);
    expect(stopped.fusionRunsCompleted).toBe(1);
    expect(stopped.journeyEventsCreated).toBe(1);
    await harness.service.awaitLoop(view.sessionId);
  });

  it('a drain timeout fails closed: LIVE_WINDOW_DRAIN_TIMEOUT + aborted journey, never READY', async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let fusionStarted = false;
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionGate: gate,
      onFusionCall: () => {
        fusionStarted = true;
      },
      drainMs: 30,
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    await until(() => fusionStarted);
    const stopped = await harness.service.stop(TENANT, view.sessionId, 'user-1');
    expect(stopped.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(stopped.errorCode).toBe('LIVE_WINDOW_DRAIN_TIMEOUT');
    expect(stopped.decision).toBe(CustomerJourneyDecision.FAILED);
    expect(harness.journeys.abortShadowJourney).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'LIVE_WINDOW_DRAIN_TIMEOUT',
      'user-1',
      expect.anything(),
    );
    // Unstick the loop so the test leaks nothing; the stuck iteration
    // finds a terminal row and finalizes nothing further.
    releaseGate();
    await harness.service.awaitLoop(view.sessionId);
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.ERROR);
  });
});

describe('LiveSessionService — pending motion at stop (Codex P1 fix 9)', () => {
  it('auto-stop during an OPEN burst fails closed to NEEDS_EVENT_REVIEW with PENDING_MOTION_AT_STOP', async () => {
    // Quiet for 11 samples, then alternating values to the end: motion is
    // still above threshold at the newest sample when the MVP bound stops
    // the session — the burst never closed, so no window processed.
    const harness = buildHarness({
      script: [
        ...Array.from({ length: 11 }, () => ({ value: 40 })),
        { value: 200 },
        { value: 40 },
        { value: 200 },
        { value: 40 },
      ],
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(harness.fusion.runLiveWindow).not.toHaveBeenCalled();
    expect(harness.journeys.appendEvent).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      expect.objectContaining({
        eventType: 'REVIEW_REQUIRED',
        note: 'PENDING_MOTION_AT_STOP',
        sourceType: 'LIVE_SHADOW',
      }),
      'user-1',
    );
    expect(row.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(row.reviewNeeded).toBeGreaterThanOrEqual(1);
  });

  it('manual stop during an OPEN burst fails closed the same way', async () => {
    const harness = buildHarness({
      script: Array.from({ length: 40 }, (_, index) => ({
        value: index % 2 === 0 ? 40 : 200,
      })),
      clockStepMs: 1000,
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    await until(() => (harness.sessions[0].framesSampled as number) >= 4);
    const stopped = await harness.service.stop(TENANT, view.sessionId, 'user-1');
    expect(stopped.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(harness.journeys.appendEvent).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      expect.objectContaining({ note: 'PENDING_MOTION_AT_STOP' }),
      'user-1',
    );
    await harness.service.awaitLoop(view.sessionId);
  });

  it('a QUIET tail still finalizes clean — READY stays reachable', async () => {
    const harness = buildHarness({ script: [{ value: 40 }] });
    await startAndFinish(harness);
    expect(harness.sessions[0].decision).toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(harness.journeys.appendEvent).not.toHaveBeenCalled();
  });
});

describe('LiveSessionService — startup-race abort failure stays retryable (Codex P1 round 2, fix 1)', () => {
  it('an abort failure after the promote race parks STOPPING with the LINKED journey, and retry closes it', async () => {
    const harness = buildHarness();
    const original =
      harness.prisma.liveCameraSession.updateMany.getMockImplementation() as (
        args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        },
      ) => Promise<{ count: number }>;
    harness.prisma.liveCameraSession.updateMany.mockImplementation(
      async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (args.data.status === LiveCameraSessionStatus.RUNNING) {
          harness.sessions[0].status = LiveCameraSessionStatus.STOPPING;
        }
        return original(args);
      },
    );
    harness.journeys.abortShadowJourney.mockRejectedValueOnce(
      new Error('transient outage with a secret-shaped detail'),
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    // Never a created journey that is neither closed nor linked: the
    // failed abort left it OPEN, so the row parks LINKED and retryable.
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(view.journeyId).toBe('journey-1');
    expect(view.errorCode).toBe('LIVE_SESSION_STOPPED_DURING_START');
    expect(JSON.stringify(harness.sessions[0])).not.toContain('secret-shaped');
    // The park recorded its durable retry intent (Invariant F).
    expect(
      harness.intents.some(
        (intent) => intent.reason === 'JOURNEY_FINALIZATION_RETRY_REQUIRED',
      ),
    ).toBe(true);
    // Retry: stop() finds the linked journey and re-runs the abort.
    const retried = await harness.service.stop(TENANT, view.sessionId, 'user-1');
    expect(retried.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(retried.decision).toBe(CustomerJourneyDecision.FAILED);
    expect(harness.journeys.abortShadowJourney).toHaveBeenCalledTimes(2);
    const retryCall = (
      harness.journeys.abortShadowJourney.mock.calls as unknown as [
        string,
        string,
        string,
      ][]
    )[1];
    expect(retryCall[1]).toBe('journey-1');
  });
});

describe('LiveSessionService — stale reclaim uses the FRESH claimed row (Codex P1 round 2, fix 2)', () => {
  it('a journey linked between the snapshot and the claim is still closed', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }],
      existingSession: {
        id: 'live-stale',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.STARTING,
        // Snapshot has NO journey — the original starter is mid-create.
        journeyId: null,
        leaseOwner: 'dead-process',
        startedAt: new Date('2026-08-17T09:00:00.000Z'),
        heartbeatAt: new Date('2026-08-17T09:30:00.000Z'),
        eventWindows: [],
      },
    });
    const original =
      harness.prisma.liveCameraSession.updateMany.getMockImplementation() as (
        args: unknown,
      ) => Promise<{ count: number }>;
    harness.prisma.liveCameraSession.updateMany.mockImplementationOnce(
      async (args: unknown) => {
        // The original starter LINKS its journey just before the claim
        // lands — the pre-claim snapshot is now stale.
        harness.sessions[0].journeyId = 'journey-late';
        return original(args);
      },
    );
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    // Cleanup used the FRESH row: the late-linked journey was aborted.
    expect(harness.journeys.abortShadowJourney).toHaveBeenCalledWith(
      TENANT,
      'journey-late',
      'LIVE_SESSION_STALE_RECLAIMED',
      'user-1',
      expect.anything(),
    );
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.ERROR);
    // The replacement session started normally — no orphan remains.
    expect(view.sessionId).not.toBe('live-stale');
    expect(view.status).toBe(LiveCameraSessionStatus.RUNNING);
    await harness.service.awaitLoop(view.sessionId);
  });
});

describe('LiveSessionService — closed windows survive a stop request (Codex P1 round 2, fix 4)', () => {
  it('a window CLOSED by the frame that arrived with the stop is still processed', async () => {
    const harness = buildHarness({
      script: [
        { value: 40 },
        { value: 200 },
        { value: 40 },
        {
          value: 40,
          onCall: () => {
            // The stop arrives exactly as the frame whose quiet sample
            // CLOSES the burst window is sampled: the frame must still
            // land and its now-closed window must process before the
            // loop exits.
            const loops = (
              harness.service as unknown as {
                loops: Map<string, { stopRequested: boolean }>;
              }
            ).loops;
            const controller = loops.get('live-1');
            if (controller) {
              controller.stopRequested = true;
            }
          },
        },
      ],
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(harness.fusion.runLiveWindow).toHaveBeenCalledTimes(1);
    expect(row.eventWindowsDetected).toBe(1);
    expect(row.eventWindowsProcessed).toBe(1);
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(row.decision).toBe(CustomerJourneyDecision.READY_TO_SETTLE_SHADOW);
  });

  it('the controller stays registered through finalization — a concurrent stop awaits it, never double-finalizes', async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const harness = buildHarness({ script: [{ value: 40 }] });
    harness.journeys.exit.mockImplementationOnce(async () => {
      await exitGate;
      return {
        id: 'journey-1',
        decision: CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
        events: [],
        issues: [],
      };
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    // Wait for the loop's OWN finalization to be mid-exit.
    await until(() => harness.journeys.exit.mock.calls.length === 1);
    const stopPromise = harness.service.stop(TENANT, view.sessionId, 'user-1');
    releaseExit();
    const stopped = await stopPromise;
    await harness.service.awaitLoop(view.sessionId);
    expect(stopped.status).toBe(LiveCameraSessionStatus.STOPPED);
    // ONE exit: the concurrent stop awaited the loop's finalization
    // instead of taking the dead-loop path and exiting again.
    expect(harness.journeys.exit).toHaveBeenCalledTimes(1);
  });
});

describe('LiveSessionService — durable, retryable markers (Codex P1 round 2, fixes 5 + 6)', () => {
  const OPEN_BURST_SCRIPT: SampleScriptEntry[] = [
    ...Array.from({ length: 11 }, () => ({ value: 40 })),
    { value: 200 },
    { value: 40 },
    { value: 200 },
    { value: 40 },
  ];

  it('a pending-motion marker append failure parks STOPPING — the exit NEVER runs; retry completes to review', async () => {
    const harness = buildHarness({ script: OPEN_BURST_SCRIPT });
    harness.journeys.appendEvent.mockRejectedValueOnce(
      new Error('transient append outage'),
    );
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(row.errorCode).toBe('PENDING_MOTION_AT_STOP');
    // The journey was NOT exited over the missing marker.
    expect(harness.journeys.exit).not.toHaveBeenCalled();
    // Retry appends the marker FIRST, then exits — review, never READY.
    const retried = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(retried.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(retried.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(harness.journeys.appendEvent).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      expect.objectContaining({ note: 'PENDING_MOTION_AT_STOP' }),
      'user-1',
    );
  });

  it('a failed-window marker append failure parks STOPPING — retry appends then exits to review', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionError: new Error('window processing broke'),
    });
    harness.journeys.appendEvent.mockRejectedValueOnce(
      new Error('transient append outage'),
    );
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(row.errorCode).toBe('LIVE_WINDOW_PROCESS_FAILED');
    expect(harness.journeys.exit).not.toHaveBeenCalled();
    // INVARIANT: detected > processed can never coexist with a session
    // whose journey settled READY_TO_SETTLE_SHADOW.
    expect(row.eventWindowsDetected).toBeGreaterThan(
      row.eventWindowsProcessed as number,
    );
    expect(row.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    const retried = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(retried.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(retried.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
  });

  it('the marker append is idempotent across retries — one marker, not one per stop()', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionError: new Error('window processing broke'),
    });
    harness.journeys.appendEvent.mockRejectedValueOnce(
      new Error('transient append outage'),
    );
    harness.journeys.exit.mockRejectedValueOnce(new Error('transient exit'));
    await startAndFinish(harness);
    // First retry: appends the marker, then the exit fails → still
    // STOPPING (retryable), marker already durable.
    await harness.service.stop(TENANT, 'live-1', 'user-1');
    // Second retry: must NOT append a second marker.
    const final = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(final.status).toBe(LiveCameraSessionStatus.STOPPED);
    const markerAppends = harness.journeyEvents.filter(
      (event) => event.note === 'LIVE_WINDOW_PROCESS_FAILED',
    );
    expect(markerAppends).toHaveLength(1);
  });
});

describe('LiveSessionService — remote-owned loops (Codex P1 round 3, fix 1)', () => {
  const REMOTE_SESSION = {
    id: 'live-remote',
    tenantId: TENANT,
    cameraSourceId: 'cam-1',
    status: LiveCameraSessionStatus.RUNNING,
    journeyId: 'journey-1',
    leaseOwner: 'remote-process',
    startedAt: new Date('2026-08-17T09:59:00.000Z'),
    // Fresh at the virtual clock start (10:00:00Z).
    heartbeatAt: new Date('2026-08-17T10:00:00.000Z'),
    eventWindows: [],
  };

  it('stop with a FRESH remote heartbeat requests STOPPING and does NOT finalize', async () => {
    const harness = buildHarness({ existingSession: { ...REMOTE_SESSION } });
    const view = await harness.service.stop(TENANT, 'live-remote', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPING);
    // The journey was NOT closed over the fresh foreign lease, and the
    // remote owner keeps its lease for the drain.
    expect(harness.journeys.exit).not.toHaveBeenCalled();
    expect(harness.journeys.abortShadowJourney).not.toHaveBeenCalled();
    expect(harness.sessions[0].leaseOwner).toBe('remote-process');
  });

  it('a remote stop request starves the beat: the OWNER loop drains and finalizes exactly once', async () => {
    const harness = buildHarness({
      script: [
        { value: 40 },
        {
          value: 40,
          onCall: () => {
            // A stop endpoint in ANOTHER process marked the row STOPPING
            // (owner kept). The local controller is untouched — only the
            // beat channel may deliver the request.
            harness.sessions[0].status = LiveCameraSessionStatus.STOPPING;
          },
        },
        { value: 40 },
        { value: 40 },
      ],
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    // The owner itself finalized — one exit, decision snapshotted.
    expect(harness.journeys.exit).toHaveBeenCalledTimes(1);
    expect(row.decision).toBe(CustomerJourneyDecision.READY_TO_SETTLE_SHADOW);
  });

  it('stop with a STALE remote owner claims atomically, then finalizes with the fresh row — never clean READY', async () => {
    const harness = buildHarness({
      existingSession: {
        ...REMOTE_SESSION,
        heartbeatAt: new Date('2026-08-17T09:30:00.000Z'),
      },
    });
    const view = await harness.service.stop(TENANT, 'live-remote', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(harness.journeys.exit).toHaveBeenCalledTimes(1);
    expect(harness.sessions[0].leaseOwner).toBeNull();
    // The claim recorded its durable intent BEFORE finalizing, so a
    // reclaimed session with a MISSING errorCode is never treated as a
    // clean stop (Codex P1: no READY over a stale reclaim).
    expect(
      harness.intents.some(
        (intent) => intent.reason === 'STALE_SESSION_RECLAIMED',
      ),
    ).toBe(true);
    expect(view.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('a stale claim with a null errorCode but RISKY counters cannot produce READY', async () => {
    const harness = buildHarness({
      existingSession: {
        ...REMOTE_SESSION,
        heartbeatAt: new Date('2026-08-17T09:30:00.000Z'),
        errorCode: null,
        eventWindowsDetected: 3,
        eventWindowsProcessed: 1,
      },
    });
    const view = await harness.service.stop(TENANT, 'live-remote', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(view.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    const reasons = harness.intents.map((intent) => intent.reason);
    expect(reasons).toContain('STALE_SESSION_RECLAIMED');
    expect(reasons).toContain('WINDOW_DETECTED_NOT_PROCESSED');
    // The counter gap materialized as a review marker before the exit.
    expect(harness.journeys.appendEvent).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      expect.objectContaining({ note: 'WINDOW_DETECTED_NOT_PROCESSED' }),
      'user-1',
    );
  });

  it('a lost stale-claim race downgrades to a stop request — never a double finalize', async () => {
    const harness = buildHarness({
      existingSession: {
        ...REMOTE_SESSION,
        heartbeatAt: new Date('2026-08-17T09:30:00.000Z'),
      },
    });
    // The remote owner revives: its beat refreshes the heartbeat just
    // before the claim's conditional write evaluates.
    const original =
      harness.prisma.liveCameraSession.updateMany.getMockImplementation() as (
        args: unknown,
      ) => Promise<{ count: number }>;
    harness.prisma.liveCameraSession.updateMany.mockImplementationOnce(
      async (args: unknown) => {
        harness.sessions[0].heartbeatAt = new Date('2026-08-17T10:00:00.000Z');
        return original(args);
      },
    );
    const view = await harness.service.stop(TENANT, 'live-remote', 'user-1');
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPING);
    expect(harness.journeys.exit).not.toHaveBeenCalled();
  });
});

describe('LiveSessionService — mandatory intent writes (Codex P1, Invariants E + F)', () => {
  it('a failed STARTUP intent write still fails closed through the abort — never a clean start', async () => {
    const harness = buildHarness();
    const originalUpdate =
      harness.prisma.liveCameraSession.updateMany.getMockImplementation() as (
        args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        },
      ) => Promise<{ count: number }>;
    harness.prisma.liveCameraSession.updateMany.mockImplementation(
      async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (args.data.status === LiveCameraSessionStatus.RUNNING) {
          harness.sessions[0].status = LiveCameraSessionStatus.STOPPING;
        }
        return originalUpdate(args);
      },
    );
    const originalIntent =
      harness.prisma.liveCameraSessionFinalizationIntent.create.getMockImplementation() as (
        args: { data: Record<string, unknown> },
      ) => Promise<unknown>;
    harness.prisma.liveCameraSessionFinalizationIntent.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        if (args.data.reason === 'STARTUP_FINALIZATION_REQUIRED') {
          throw new Error('intent write outage');
        }
        return originalIntent(args);
      },
    );
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(ConflictException);
    // The failed mandatory write routed into the ERROR path: the linked
    // journey was aborted (fail closed), never exited clean.
    expect(harness.sessions[0].status).toBe(LiveCameraSessionStatus.ERROR);
    expect(harness.journeys.exit).not.toHaveBeenCalled();
    expect(harness.journeys.abortShadowJourney).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      'STAGE_FAILED',
      'user-1',
      expect.anything(),
    );
    expect(harness.sessions[0].decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('a transient failed-window intent write is RETRIED until it lands — then finalization fails closed', async () => {
    const harness = buildHarness({
      script: [
        { value: 40 },
        { value: 200 },
        { value: 40 },
        { value: 40 },
        { value: 40 },
      ],
      fusionError: new Error('window processing broke'),
    });
    const original =
      harness.prisma.liveCameraSessionFinalizationIntent.create.getMockImplementation() as (
        args: { data: Record<string, unknown> },
      ) => Promise<unknown>;
    harness.prisma.liveCameraSessionFinalizationIntent.create
      .mockImplementationOnce(async () => {
        throw new Error('transient intent write outage');
      })
      .mockImplementation(original);
    await startAndFinish(harness);
    const row = harness.sessions[0];
    // The retried intent landed; the marker went in before the exit.
    expect(
      harness.intents.some(
        (intent) => intent.reason === 'LIVE_WINDOW_PROCESS_FAILED',
      ),
    ).toBe(true);
    expect(row.errorCode).toBe('LIVE_WINDOW_PROCESS_FAILED');
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(row.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(
      harness.journeyEvents.filter(
        (event) => event.note === 'LIVE_WINDOW_PROCESS_FAILED',
      ),
    ).toHaveLength(1);
  });

  it('when the failed-window intent can NEVER persist, the loop leaves the row OWNED and non-terminal — no exit, no READY', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionError: new Error('window processing broke'),
    });
    harness.prisma.liveCameraSessionFinalizationIntent.create.mockRejectedValue(
      new Error('persistent intent outage'),
    );
    await startAndFinish(harness);
    const row = harness.sessions[0];
    // Never finalized: owned, non-terminal, journey untouched — the aging
    // lease hands the row to stale reclaim, which aborts the journey.
    expect(row.status).toBe(LiveCameraSessionStatus.RUNNING);
    expect(row.leaseOwner).not.toBeNull();
    expect(harness.journeys.exit).not.toHaveBeenCalled();
    expect(row.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });

  it('when the pending-motion intent can NEVER persist, the loop leaves the row OWNED — the exit never runs', async () => {
    const harness = buildHarness({
      script: [
        ...Array.from({ length: 11 }, () => ({ value: 40 })),
        { value: 200 },
        { value: 40 },
        { value: 200 },
        { value: 40 },
      ],
    });
    harness.prisma.liveCameraSessionFinalizationIntent.create.mockRejectedValue(
      new Error('persistent intent outage'),
    );
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.RUNNING);
    expect(row.leaseOwner).not.toBeNull();
    expect(harness.journeys.exit).not.toHaveBeenCalled();
    expect(row.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
  });
});

describe('LiveSessionService — durable ADDITIVE intents (Codex P1, Invariant E)', () => {
  it('a failed window AND pending motion at stop preserve BOTH intents — neither overwrites the other', async () => {
    const harness = buildHarness({
      // Quiet lead-in, one CLOSED burst (fails in fusion), quiet gap,
      // then an OPEN burst right at the auto-stop bound.
      script: [
        { value: 40 },
        { value: 200 },
        { value: 40 },
        ...Array.from({ length: 8 }, () => ({ value: 40 })),
        { value: 200 },
        { value: 40 },
        { value: 200 },
        { value: 40 },
      ],
      fusionError: new Error('window processing broke'),
    });
    await startAndFinish(harness);
    const reasons = harness.intents.map((intent) => intent.reason);
    expect(reasons).toContain('LIVE_WINDOW_PROCESS_FAILED');
    expect(reasons).toContain('PENDING_MOTION_AT_STOP');
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(row.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    // BOTH intents materialized as review-required markers on the fold.
    for (const note of [
      'LIVE_WINDOW_PROCESS_FAILED',
      'PENDING_MOTION_AT_STOP',
    ]) {
      expect(
        harness.journeyEvents.filter(
          (event) =>
            event.eventType === 'REVIEW_REQUIRED' && event.note === note,
        ),
      ).toHaveLength(1);
    }
  });

  it('a counter gap (detected > processed) with a MISSING errorCode still adds an intent and never exits READY', async () => {
    const harness = buildHarness({
      existingSession: {
        id: 'live-1',
        tenantId: TENANT,
        cameraSourceId: 'cam-1',
        status: LiveCameraSessionStatus.RUNNING,
        journeyId: 'journey-1',
        leaseOwner: null,
        errorCode: null,
        startedAt: new Date(),
        eventWindowsDetected: 2,
        eventWindowsProcessed: 1,
        eventWindows: [],
      },
    });
    const view = await harness.service.stop(TENANT, 'live-1', 'user-1');
    expect(
      harness.intents.some(
        (intent) => intent.reason === 'WINDOW_DETECTED_NOT_PROCESSED',
      ),
    ).toBe(true);
    expect(view.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(view.decision).toBe(CustomerJourneyDecision.NEEDS_EVENT_REVIEW);
    expect(view.decision).not.toBe(
      CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    );
    expect(harness.journeys.appendEvent).toHaveBeenCalledWith(
      TENANT,
      'journey-1',
      expect.objectContaining({
        eventType: 'REVIEW_REQUIRED',
        note: 'WINDOW_DETECTED_NOT_PROCESSED',
        sourceType: 'LIVE_SHADOW',
      }),
      'user-1',
    );
  });
});

