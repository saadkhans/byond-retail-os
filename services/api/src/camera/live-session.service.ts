import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CameraSourceStatus,
  CameraSourceType,
  CustomerJourneyDecision,
  LiveCameraSession,
  LiveCameraSessionStatus,
  Prisma,
} from '@prisma/client';
import { JourneyService } from '../journey/journey.service';
import {
  AnalysisFrame,
  AnalysisGeometry,
} from '../pickup-detection/analysis/pickup-analyzer';
import { PickupFusionService } from '../pickup-fusion/pickup-fusion.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CameraSourcesService,
  RTSP_NEEDS_CREDENTIAL_SLOT,
} from './camera-sources.service';
import {
  DEFAULT_EVENT_WINDOW_CONFIG,
  EventWindow,
  extractEventWindows,
  motionSamples,
  parseShelfZone,
} from './event-windows';
import { RtspFrameSampler } from './rtsp/rtsp-frame-sampler';

/**
 * Phase 13 — live RTSP shadow sessions (SHADOW ONLY).
 *
 * One session = one start of a live camera: an in-process sampling loop
 * (MVP explicitly — no queues, no streaming infrastructure) pulls single
 * frames through the RTSP sampler, finds heuristic motion windows with
 * the SAME pure Phase 12 event-window code the replay runtime uses, and
 * drives each window through the EXISTING window-scoped fusion + journey
 * import path. The session owns ONE shadow journey (ENTRY at start, EXIT
 * at stop); observations land on the session's real timeline, so
 * ENTRY ≤ observations ≤ EXIT holds by construction.
 *
 * This service never talks to the VLM (only fusion does), never persists
 * raw exception text (controlled error CODES only), never returns URL or
 * credential material, and never touches checkout, order, payment, or
 * inventory tables.
 */

export const DEFAULT_LIVE_FRAME_INTERVAL_MS = 1000;
export const MIN_LIVE_FRAME_INTERVAL_MS = 500;

/** MVP safety bound: a live session auto-stops after this long — nothing
 *  in the shadow pilot may sample a stream indefinitely. */
export const MAX_LIVE_SESSION_MS = 15 * 60_000;

/** Rolling frame buffer bound — the loop's memory is fixed no matter how
 *  long the session runs. At the default 1s interval this is two minutes
 *  of context, far beyond any single shelf interaction. */
export const LIVE_FRAME_BUFFER_MAX = 120;

/** This many CONSECUTIVE sampler failures finalize the session as ERROR
 *  with the sampler's own controlled code. */
export const LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES = 5;

/** Periodic lease heartbeat, same discipline as the replay runtime. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 60_000;

/** Quiet lead-in included before a window's frames when handing them to
 *  fusion — the detector needs baseline context (Phase 12 lesson). */
export const LIVE_WINDOW_LEAD_IN_MS = 1000;

/** Fixed analysis geometry the sampler is asked to deliver (even dims,
 *  matches the pickup pipeline's ~192px analysis width). */
export const LIVE_ANALYSIS_GEOMETRY: AnalysisGeometry = {
  width: 192,
  height: 108,
};

const ACTIVE_SESSION_STATUSES: LiveCameraSessionStatus[] = [
  LiveCameraSessionStatus.STARTING,
  LiveCameraSessionStatus.RUNNING,
];

const NON_TERMINAL_SESSION_STATUSES: LiveCameraSessionStatus[] = [
  LiveCameraSessionStatus.STARTING,
  LiveCameraSessionStatus.RUNNING,
  LiveCameraSessionStatus.STOPPING,
];

export interface LiveSessionView {
  sessionId: string;
  cameraSourceId: string;
  cameraSourceName: string | null;
  sourceType: CameraSourceType | null;
  journeyId: string | null;
  status: LiveCameraSessionStatus;
  frameIntervalMs: number;
  startedAt: Date;
  stoppedAt: Date | null;
  heartbeatAt: Date | null;
  lastFrameAt: Date | null;
  framesSampled: number;
  eventWindowsDetected: number;
  eventWindowsProcessed: number;
  fusionRunsCompleted: number;
  journeyEventsCreated: number;
  vlmInvoked: number;
  vlmSkipped: number;
  vlmFailed: number;
  reviewNeeded: number;
  decision: CustomerJourneyDecision | null;
  /** Controlled code only — raw exception text is never persisted. */
  errorCode: string | null;
}

export interface LiveSessionDetail extends LiveSessionView {
  eventWindows: EventWindow[];
}

type SessionWithSource = LiveCameraSession & {
  cameraSource: { name: string; sourceType: CameraSourceType } | null;
};

function classifyError(error: unknown): string {
  if (error instanceof ConflictException) {
    return 'STAGE_UNAVAILABLE';
  }
  if (error instanceof NotFoundException) {
    return 'STAGE_NOT_FOUND';
  }
  return 'STAGE_FAILED';
}

function toView(session: SessionWithSource): LiveSessionView {
  return {
    sessionId: session.id,
    cameraSourceId: session.cameraSourceId,
    cameraSourceName: session.cameraSource?.name ?? null,
    sourceType: session.cameraSource?.sourceType ?? null,
    journeyId: session.journeyId,
    status: session.status,
    frameIntervalMs: session.frameIntervalMs,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    heartbeatAt: session.heartbeatAt,
    lastFrameAt: session.lastFrameAt,
    framesSampled: session.framesSampled,
    eventWindowsDetected: session.eventWindowsDetected,
    eventWindowsProcessed: session.eventWindowsProcessed,
    fusionRunsCompleted: session.fusionRunsCompleted,
    journeyEventsCreated: session.journeyEventsCreated,
    vlmInvoked: session.vlmInvoked,
    vlmSkipped: session.vlmSkipped,
    vlmFailed: session.vlmFailed,
    reviewNeeded: session.reviewNeeded,
    decision: session.decision,
    errorCode: session.errorCode,
  };
}

function toDetail(session: SessionWithSource): LiveSessionDetail {
  return {
    ...toView(session),
    eventWindows: Array.isArray(session.eventWindows)
      ? (session.eventWindows as unknown as EventWindow[])
      : [],
  };
}

const SOURCE_INCLUDE = {
  cameraSource: { select: { name: true, sourceType: true } },
} as const;

@Injectable()
export class LiveSessionService {
  private readonly logger = new Logger(LiveSessionService.name);

  /** In-process loop controllers — stop() signals through here when the
   *  loop is alive in THIS process. */
  private readonly loops = new Map<string, { stopRequested: boolean }>();

  /** Loop completion promises — a TEST HOOK ONLY (awaitLoop), never part
   *  of the request path. */
  private readonly loopPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: CameraSourcesService,
    private readonly sampler: RtspFrameSampler,
    private readonly fusion: PickupFusionService,
    private readonly journeys: JourneyService,
  ) {}

  /** Overridable for deterministic specs. */
  protected now(): Date {
    return new Date();
  }

  /** Overridable for deterministic specs. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  /** TEST HOOK: await a detached sampling loop's completion. */
  async awaitLoop(sessionId: string): Promise<void> {
    await this.loopPromises.get(sessionId);
  }

  async start(
    tenantId: string,
    cameraSourceId: string,
    input: { frameIntervalMs?: number | null },
    actorId?: string,
  ): Promise<LiveSessionDetail> {
    const source = await this.sources.requireSource(tenantId, cameraSourceId);
    if (source.sourceType !== CameraSourceType.RTSP_SHADOW) {
      throw new ConflictException(
        'live sessions need an RTSP_SHADOW camera source',
      );
    }
    if (source.status !== CameraSourceStatus.ACTIVE) {
      throw new ConflictException('camera source is not ACTIVE');
    }
    if (source.credentialRef === null) {
      throw new ConflictException(RTSP_NEEDS_CREDENTIAL_SLOT);
    }
    // IDEMPOTENT-SAFE start: an already-active session for this source IS
    // the answer — no second session, no second journey.
    const active = await this.prisma.liveCameraSession.findFirst({
      where: {
        tenantId,
        cameraSourceId,
        status: { in: ACTIVE_SESSION_STATUSES },
      },
      include: SOURCE_INCLUDE,
    });
    if (active) {
      return toDetail(active as SessionWithSource);
    }
    // Runtime preconditions BEFORE any side effect. Controlled codes only.
    if (!this.sampler.resolveSource(source.credentialRef).configured) {
      throw new ConflictException(
        'RTSP source is not configured in this environment ' +
          '(RTSP_SOURCE_NOT_CONFIGURED)',
      );
    }
    if (!(await this.sampler.checkFfmpeg())) {
      throw new ConflictException(
        'frame sampling is unavailable in this environment ' +
          '(RTSP_UNSUPPORTED_IN_ENV)',
      );
    }
    const frameIntervalMs =
      input.frameIntervalMs ?? DEFAULT_LIVE_FRAME_INTERVAL_MS;

    // LEASE OWNERSHIP: this attempt's token — every later write is
    // conditional on (non-terminal status AND this owner).
    const leaseOwner = randomUUID();
    let session: LiveCameraSession;
    try {
      session = await this.prisma.liveCameraSession.create({
        data: {
          tenantId,
          cameraSourceId,
          frameIntervalMs,
          leaseOwner,
          heartbeatAt: this.now(),
          createdById: actorId ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // RACE BACKSTOP: the partial unique (one non-terminal session per
        // source) means a concurrent start won — its session is THE
        // session.
        const winner = await this.prisma.liveCameraSession.findFirst({
          where: {
            tenantId,
            cameraSourceId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
          },
          include: SOURCE_INCLUDE,
        });
        if (winner) {
          return toDetail(winner as SessionWithSource);
        }
      }
      throw error;
    }

    // Open the session's shadow journey. ENTRY is anchored to the session
    // start — the same base every live observation uses. A failure AFTER
    // the row exists finalizes ERROR and aborts the journey if it opened:
    // no orphan OPEN journey, no RUNNING ghost row.
    let journeyId: string | null = null;
    try {
      const journey = await this.journeys.create(
        tenantId,
        { locationId: source.locationId, unitId: source.unitId },
        actorId,
        { entryAt: session.startedAt },
      );
      journeyId = journey.id;
      const promoted = await this.prisma.liveCameraSession.updateMany({
        where: {
          id: session.id,
          tenantId,
          status: LiveCameraSessionStatus.STARTING,
          leaseOwner,
        },
        data: { journeyId, status: LiveCameraSessionStatus.RUNNING },
      });
      if (promoted.count === 0) {
        // Someone else took the row (stop raced the start) — do not run.
        return this.byId(tenantId, session.id);
      }
    } catch (error) {
      await this.finalizeError(
        tenantId,
        session.id,
        classifyError(error),
        actorId,
        { leaseOwner, journeyId },
      );
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.warn(
        `live session ${session.id} failed to start (${classifyError(error)})`,
      );
      throw new ConflictException('live session failed to start');
    }

    // Detached in-process loop — the MVP runtime.
    const loopPromise = this.runLoop(
      tenantId,
      session.id,
      leaseOwner,
      {
        cameraSourceId,
        credentialRef: source.credentialRef,
        locationId: source.locationId,
        unitId: source.unitId,
        shelfZone: source.shelfZone,
        journeyId,
        frameIntervalMs,
        startedAt: session.startedAt,
      },
      actorId,
    ).catch((error) => {
      this.logger.error(
        `live session ${session.id} loop crashed (${classifyError(error)})`,
      );
      return this.finalizeError(
        tenantId,
        session.id,
        'LIVE_LOOP_FAILED',
        actorId,
        { leaseOwner, journeyId },
      ).catch(() => undefined);
    });
    this.loopPromises.set(
      session.id,
      loopPromise.then(() => undefined),
    );

    return this.byId(tenantId, session.id);
  }

  private async runLoop(
    tenantId: string,
    sessionId: string,
    leaseOwner: string,
    context: {
      cameraSourceId: string;
      credentialRef: string;
      locationId: string;
      unitId: string | null;
      shelfZone: string | null;
      journeyId: string | null;
      frameIntervalMs: number;
      startedAt: Date;
    },
    actorId?: string,
  ): Promise<void> {
    const controller = { stopRequested: false };
    this.loops.set(sessionId, controller);
    const zone = parseShelfZone(context.shelfZone);
    const buffer: AnalysisFrame[] = [];
    const processedWindows: EventWindow[] = [];
    const counters = {
      framesSampled: 0,
      eventWindowsDetected: 0,
      eventWindowsProcessed: 0,
      fusionRunsCompleted: 0,
      journeyEventsCreated: 0,
      vlmInvoked: 0,
      vlmSkipped: 0,
      vlmFailed: 0,
      reviewNeeded: 0,
    };
    let frameIndex = 0;
    let consecutiveFailures = 0;
    /** Cooldown watermark: windows ending at/before this are done. */
    let processedUpToMs = 0;
    let leaseLost = false;
    let errorCode: string | null = null;
    const startedAtMs = context.startedAt.getTime();

    // The beat is the ownership probe: zero rows ⇒ the lease was taken
    // (stop endpoint, stale takeover) ⇒ this loop stops WITHOUT
    // finalizing. Best-effort on transport errors.
    const beat = async (): Promise<void> => {
      const alive = await this.prisma.liveCameraSession
        .updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: LiveCameraSessionStatus.RUNNING,
            leaseOwner,
          },
          data: { heartbeatAt: this.now() },
        })
        .catch(() => null);
      if (alive !== null && alive.count === 0) {
        leaseLost = true;
      }
    };
    const heartbeatTimer = setInterval(() => {
      void beat();
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    /** Persist the loop's counters — conditional on ownership, absolute
     *  values (no read-modify-write races with ourselves). */
    const persist = async (
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      const written = await this.prisma.liveCameraSession
        .updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: LiveCameraSessionStatus.RUNNING,
            leaseOwner,
          },
          data: {
            ...counters,
            eventWindows:
              processedWindows as unknown as Prisma.InputJsonValue,
            heartbeatAt: this.now(),
            ...extra,
          },
        })
        .catch(() => null);
      if (written !== null && written.count === 0) {
        leaseLost = true;
      }
    };

    try {
      for (;;) {
        if (controller.stopRequested || leaseLost) {
          break;
        }
        if (this.now().getTime() - startedAtMs >= MAX_LIVE_SESSION_MS) {
          // MVP safety bound — normal stop path.
          break;
        }
        const sampled = await this.sampler.sampleFrame(context.credentialRef, {
          width: LIVE_ANALYSIS_GEOMETRY.width,
          height: LIVE_ANALYSIS_GEOMETRY.height,
          timeoutMs: Math.min(context.frameIntervalMs * 2, 10_000),
        });
        if (controller.stopRequested || leaseLost) {
          break;
        }
        if (sampled.ok) {
          consecutiveFailures = 0;
          const timestampMs = this.now().getTime() - startedAtMs;
          buffer.push({
            index: frameIndex,
            timestampMs,
            rgb: sampled.image.rgb,
          });
          frameIndex += 1;
          if (buffer.length > LIVE_FRAME_BUFFER_MAX) {
            buffer.shift();
          }
          counters.framesSampled += 1;
          await persist({ lastFrameAt: this.now() });

          // Heuristic windows over the rolling buffer. Only CLOSED
          // windows (quiet again before the newest sample) are processed;
          // the watermark is the cooldown — a window overlapping an
          // already-processed range is the same physical interaction.
          const samples = motionSamples(buffer, LIVE_ANALYSIS_GEOMETRY, zone);
          const lastSampleMs = samples[samples.length - 1]?.timestampMs ?? 0;
          for (const window of extractEventWindows(
            samples,
            DEFAULT_EVENT_WINDOW_CONFIG,
          )) {
            if (leaseLost || controller.stopRequested) {
              break;
            }
            if (window.startMs <= processedUpToMs) {
              continue;
            }
            if (window.endMs >= lastSampleMs) {
              continue; // still open — wait for the burst to end
            }
            processedUpToMs = window.endMs;
            counters.eventWindowsDetected += 1;
            processedWindows.push(window);
            await this.processWindow(
              tenantId,
              sessionId,
              context,
              buffer,
              window,
              counters,
              actorId,
            ).catch((error) => {
              // One window's failure never ends the session — log the
              // class and keep sampling.
              this.logger.warn(
                `live session ${sessionId} window failed (${classifyError(error)})`,
              );
            });
            await persist();
          }
        } else {
          consecutiveFailures += 1;
          if (consecutiveFailures >= LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES) {
            errorCode = sampled.code;
            break;
          }
        }
        await this.sleep(context.frameIntervalMs);
        await beat();
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.loops.delete(sessionId);
    }

    if (leaseLost) {
      this.logger.warn(
        `live session ${sessionId} lost its lease — loop stopped without finalizing`,
      );
      return;
    }
    await persist();
    if (errorCode) {
      await this.finalizeError(tenantId, sessionId, errorCode, actorId, {
        leaseOwner,
        journeyId: context.journeyId,
      });
      return;
    }
    await this.finalizeStopped(tenantId, sessionId, actorId, { leaseOwner });
  }

  /** One closed window → window-scoped fusion → exact-run journey import.
   *  VLM counters follow the pilot-run rule: invoked with a VERDICT is a
   *  clean invocation; invoked with any error status counts invoked AND
   *  failed; not invoked is skipped. */
  private async processWindow(
    tenantId: string,
    sessionId: string,
    context: {
      locationId: string;
      unitId: string | null;
      journeyId: string | null;
      frameIntervalMs: number;
      startedAt: Date;
    },
    buffer: AnalysisFrame[],
    window: EventWindow,
    counters: {
      eventWindowsProcessed: number;
      fusionRunsCompleted: number;
      journeyEventsCreated: number;
      vlmInvoked: number;
      vlmSkipped: number;
      vlmFailed: number;
      reviewNeeded: number;
    },
    actorId?: string,
  ): Promise<void> {
    const frames = buffer
      .filter(
        (frame) =>
          frame.timestampMs >= window.startMs - LIVE_WINDOW_LEAD_IN_MS &&
          frame.timestampMs <= window.endMs + context.frameIntervalMs,
      )
      .map((frame) => ({
        timestampMs: frame.timestampMs,
        image: {
          width: LIVE_ANALYSIS_GEOMETRY.width,
          height: LIVE_ANALYSIS_GEOMETRY.height,
          rgb: frame.rgb,
        },
      }));
    const { runId } = await this.fusion.runLiveWindow(tenantId, {
      liveSessionId: sessionId,
      locationId: context.locationId,
      unitId: context.unitId,
      frames,
      window: {
        startMs: window.startMs,
        endMs: window.endMs,
        peakMs: window.peakMs,
      },
    });
    counters.fusionRunsCompleted += 1;
    const runRow = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, id: runId },
      select: { evidence: true },
    });
    const vlm = (
      runRow?.evidence as
        | { vlm?: { invoked?: boolean; status?: string | null } }
        | undefined
    )?.vlm;
    if (vlm?.invoked === true) {
      counters.vlmInvoked += 1;
      if (vlm.status !== 'VERDICT') {
        counters.vlmFailed += 1;
      }
    } else {
      counters.vlmSkipped += 1;
    }
    if (context.journeyId) {
      const detail = await this.journeys.appendFromLiveFusionRun(
        tenantId,
        context.journeyId,
        runId,
        actorId,
        {
          sourceTimeBase: context.startedAt,
          fallbackPeakMs: window.peakMs,
        },
      );
      counters.journeyEventsCreated = detail.events.filter(
        (event) => event.sourceType === 'LIVE_SHADOW',
      ).length;
      counters.reviewNeeded = detail.issues.length;
    }
    counters.eventWindowsProcessed += 1;
  }

  /**
   * Normal finalization: exit + reconcile the journey, then a CONDITIONAL
   * status write. `force` (stop endpoint / process-restart path) takes
   * over regardless of the lease owner; the loop's own call stays
   * owner-conditional so a takeover always wins.
   */
  private async finalizeStopped(
    tenantId: string,
    sessionId: string,
    actorId?: string,
    options?: { leaseOwner?: string },
  ): Promise<void> {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (
      !session ||
      session.status === LiveCameraSessionStatus.STOPPED ||
      session.status === LiveCameraSessionStatus.ERROR
    ) {
      return;
    }
    const stoppedAt = this.now();
    let decision: CustomerJourneyDecision | null = null;
    if (session.journeyId) {
      try {
        const exited = await this.journeys.exit(
          tenantId,
          session.journeyId,
          actorId,
          { exitAt: stoppedAt },
        );
        decision = exited.decision;
      } catch (error) {
        if (error instanceof ConflictException) {
          // Already closed (a competing finalizer exited it) — read the
          // decision it settled on.
          const detail = await this.journeys
            .detail(tenantId, session.journeyId)
            .catch(() => null);
          decision = detail?.decision ?? null;
        } else {
          this.logger.warn(
            `live session ${sessionId} journey exit failed (${classifyError(error)})`,
          );
        }
      }
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
        ...(options?.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
      },
      data: {
        status: LiveCameraSessionStatus.STOPPED,
        stoppedAt,
        decision,
        leaseOwner: null,
      },
    });
  }

  /** Failure finalization: ERROR with a controlled code, journey aborted
   *  (decision FAILED) so no OPEN orphan survives the session. */
  private async finalizeError(
    tenantId: string,
    sessionId: string,
    errorCode: string,
    actorId?: string,
    options?: { leaseOwner?: string; journeyId?: string | null },
  ): Promise<void> {
    const stoppedAt = this.now();
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    const journeyId = options?.journeyId ?? session?.journeyId ?? null;
    let decision: CustomerJourneyDecision | null = null;
    if (journeyId) {
      try {
        const aborted = await this.journeys.abortShadowJourney(
          tenantId,
          journeyId,
          errorCode,
          actorId,
          { exitAt: stoppedAt },
        );
        decision = aborted.decision;
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          this.logger.warn(
            `live session ${sessionId} journey abort failed (${classifyError(error)})`,
          );
        }
      }
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
        ...(options?.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
      },
      data: {
        status: LiveCameraSessionStatus.ERROR,
        errorCode,
        stoppedAt,
        decision,
        leaseOwner: null,
      },
    });
  }

  /**
   * Stop — safe even when the loop is dead (process restarted): the
   * endpoint marks STOPPING, signals a live loop when one exists here,
   * and finalizes DIRECTLY with takeover semantics. Stopping a terminal
   * session is idempotent and returns its view unchanged.
   */
  async stop(
    tenantId: string,
    sessionId: string,
    actorId?: string,
  ): Promise<LiveSessionDetail> {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
      include: SOURCE_INCLUDE,
    });
    if (!session) {
      throw new NotFoundException('Live session not found');
    }
    if (
      session.status === LiveCameraSessionStatus.STOPPED ||
      session.status === LiveCameraSessionStatus.ERROR
    ) {
      return toDetail(session as SessionWithSource);
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
      },
      data: { status: LiveCameraSessionStatus.STOPPING },
    });
    const controller = this.loops.get(sessionId);
    if (controller) {
      controller.stopRequested = true;
    }
    // Takeover finalization (no lease condition): deterministic STOPPED on
    // return; a still-draining loop's own finalize then finds a terminal
    // row and does nothing.
    await this.finalizeStopped(tenantId, sessionId, actorId);
    return this.byId(tenantId, sessionId);
  }

  async list(tenantId: string): Promise<LiveSessionView[]> {
    const sessions = await this.prisma.liveCameraSession.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: SOURCE_INCLUDE,
    });
    return sessions.map((session) => toView(session as SessionWithSource));
  }

  async byId(tenantId: string, sessionId: string): Promise<LiveSessionDetail> {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
      include: SOURCE_INCLUDE,
    });
    if (!session) {
      throw new NotFoundException('Live session not found');
    }
    return toDetail(session as SessionWithSource);
  }
}
