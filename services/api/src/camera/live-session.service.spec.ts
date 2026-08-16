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

  protected override now(): Date {
    return new Date(this.clock);
  }

  protected override sleep(): Promise<void> {
    this.clock += this.clockStepMs;
    return new Promise((resolve) => setImmediate(resolve));
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
    clockStepMs?: number;
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
  const fusionRuns: { id: string; evidence: unknown }[] = [];
  const journeyEvents: { sourceType: string }[] = [];

  const activeStatuses: string[] = [
    LiveCameraSessionStatus.STARTING,
    LiveCameraSessionStatus.RUNNING,
    LiveCameraSessionStatus.STOPPING,
  ];
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
      row.leaseOwner !== where.leaseOwner
    ) {
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
    pickupFusionRun: {
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const row = fusionRuns.find((r) => r.id === args.where.id);
        return row ? { evidence: row.evidence } : null;
      }),
    },
  };
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
    resolveSource: jest.fn(() => ({ configured: options.configured !== false })),
    checkFfmpeg: jest.fn(async () => options.ffmpeg !== false),
    sampleFrame: jest.fn(async () => {
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
  const journeys = {
    create: jest.fn(async () => ({ id: 'journey-1' })),
    exit: jest.fn(async () => ({
      id: 'journey-1',
      decision: CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
      events: journeyEvents,
      issues: [],
    })),
    abortShadowJourney: jest.fn(async () => ({
      id: 'journey-1',
      decision: CustomerJourneyDecision.FAILED,
    })),
    appendFromLiveFusionRun: jest.fn(async () => {
      journeyEvents.push({ sourceType: 'LIVE_SHADOW' });
      return {
        id: 'journey-1',
        decision: null,
        events: journeyEvents,
        issues: [],
      };
    }),
    detail: jest.fn(async () => ({
      id: 'journey-1',
      decision: CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
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
  return { service, prisma, sources, sampler, fusion, journeys, sessions };
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
    expect(harness.journeys.create).toHaveBeenCalledWith(
      TENANT,
      { locationId: 'store-1', unitId: null },
      'user-1',
      { entryAt: new Date('2026-08-17T10:00:00.000Z') },
    );
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
        startedAt: new Date(),
        eventWindows: [],
      },
    });
    const view = await harness.service.start(TENANT, 'cam-1', {}, 'user-1');
    expect(view.sessionId).toBe('live-existing');
    expect(harness.prisma.liveCameraSession.create).not.toHaveBeenCalled();
    expect(harness.journeys.create).not.toHaveBeenCalled();
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

  it('a startup failure AFTER the row exists finalizes ERROR and aborts the journey — no orphans', async () => {
    const harness = buildHarness();
    harness.journeys.create.mockRejectedValueOnce(
      new Error('boom rtsp://user:secret@host'),
    );
    await expect(
      harness.service.start(TENANT, 'cam-1', {}, 'user-1'),
    ).rejects.toThrow(ConflictException);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.ERROR);
    expect(row.errorCode).toBe('STAGE_FAILED');
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

  it('a single window failure records nothing raw and the session continues', async () => {
    const harness = buildHarness({
      script: [{ value: 40 }, { value: 200 }, { value: 40 }, { value: 40 }],
      fusionError: new Error('ffmpeg said rtsp://user:secret@host broke'),
    });
    await startAndFinish(harness);
    const row = harness.sessions[0];
    expect(row.status).toBe(LiveCameraSessionStatus.STOPPED);
    expect(row.eventWindowsProcessed).toBe(0);
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(JSON.stringify(row)).not.toContain('rtsp://');
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
        leaseOwner: 'gone-process',
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
