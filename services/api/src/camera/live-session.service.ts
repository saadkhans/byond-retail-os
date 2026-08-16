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
  CustomerJourneyEventType,
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

/** A persisted STARTING/RUNNING row with no in-memory loop and a
 *  heartbeat older than this is a CRASH LEFTOVER — reclaimable so the
 *  camera is not blocked forever (Codex P1). 5× the heartbeat interval:
 *  a healthy loop can never look stale. */
export const LIVE_SESSION_STALE_MS = 5 * 60_000;

/** Bound on how long stop() waits for the in-process loop to drain its
 *  in-flight window processing before failing closed (Codex P1). */
export const LIVE_STOP_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Controlled error codes introduced by the Phase 13 safety hardening —
 * the ONLY strings that may land in LiveCameraSession.errorCode from
 * these paths (raw exception text never persists):
 *   LIVE_SESSION_STOPPED_DURING_START — a stop() raced startup; the
 *     freshly opened journey was aborted, never left OPEN and detached;
 *   LIVE_SESSION_STALE_RECLAIMED — a crash leftover (active row, no
 *     loop, expired heartbeat) was reclaimed and its journey closed;
 *   JOURNEY_FINALIZE_RETRY — the journey could not be closed when the
 *     session finalized; the row stays STOPPING and a later stop()
 *     retries the closure (never a terminal state over an OPEN journey);
 *   LIVE_WINDOW_DRAIN_TIMEOUT — in-flight window processing did not
 *     settle within the drain bound at stop; failed closed (abort);
 *   LIVE_WINDOW_PROCESS_FAILED — a DETECTED window's fusion/import
 *     failed; the journey is marked review-required at finalization so
 *     the session can never end READY_TO_SETTLE_SHADOW;
 *   PENDING_MOTION_AT_STOP — motion was still in progress when the
 *     session stopped; recorded as a review-required marker (journey
 *     event note), fail-closed instead of silently dropped.
 */
export const LIVE_SESSION_ERROR_CODES = [
  'LIVE_SESSION_STOPPED_DURING_START',
  'LIVE_SESSION_STALE_RECLAIMED',
  'JOURNEY_FINALIZE_RETRY',
  'LIVE_WINDOW_DRAIN_TIMEOUT',
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
] as const;

const STOPPED_DURING_START = 'LIVE_SESSION_STOPPED_DURING_START';
const STALE_RECLAIMED = 'LIVE_SESSION_STALE_RECLAIMED';
const JOURNEY_FINALIZE_RETRY = 'JOURNEY_FINALIZE_RETRY';
const WINDOW_DRAIN_TIMEOUT = 'LIVE_WINDOW_DRAIN_TIMEOUT';
const WINDOW_PROCESS_FAILED = 'LIVE_WINDOW_PROCESS_FAILED';
const PENDING_MOTION_AT_STOP = 'PENDING_MOTION_AT_STOP';

/** errorCodes whose retry path is a normal STOP finalization (exit +
 *  reconcile) rather than an abort — see stop()'s dead-loop routing. */
const STOP_INTENT_CODES: readonly string[] = [
  JOURNEY_FINALIZE_RETRY,
  WINDOW_PROCESS_FAILED,
];

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
    // the answer — no second session, no second journey. But an active
    // ROW with no loop and an expired heartbeat is a crash leftover
    // (Codex P1): reclaim it atomically so the camera is not blocked
    // forever, close its journey, and only then start fresh.
    const active = await this.prisma.liveCameraSession.findFirst({
      where: {
        tenantId,
        cameraSourceId,
        status: { in: ACTIVE_SESSION_STATUSES },
      },
      include: SOURCE_INCLUDE,
    });
    if (active) {
      if (this.loops.has(active.id)) {
        return toDetail(active as SessionWithSource);
      }
      const heartbeatMs = (active.heartbeatAt ?? active.startedAt).getTime();
      if (this.now().getTime() - heartbeatMs < LIVE_SESSION_STALE_MS) {
        // Fresh heartbeat, no LOCAL loop — a loop may live in another
        // process. Conservative: never reclaim a possibly-live session.
        return toDetail(active as SessionWithSource);
      }
      const reclaimed = await this.reclaimStaleSession(
        tenantId,
        active as SessionWithSource,
        actorId,
      );
      if (!reclaimed) {
        // Lost the reclaim race (a real loop beat us, or another start
        // reclaimed first) — the row's CURRENT state is the answer.
        return this.byId(tenantId, active.id);
      }
      // Reclaim complete (terminal ERROR, journey closed): fall through
      // to a fresh start — the partial unique is free again.
    }
    // Runtime preconditions BEFORE any side effect. Controlled codes only.
    if (!this.sampler.resolveSource(tenantId, source.credentialRef).configured) {
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
      // LINK FIRST, promote second (Codex P1): the journeyId lands with
      // an ownership-conditional write BEFORE anything else happens. If a
      // racing stop() finalized the STARTING row in the meantime, the
      // link write matches nothing — the fresh journey is then explicitly
      // ABORTED, never returned OPEN and detached from any session.
      const linked = await this.prisma.liveCameraSession.updateMany({
        where: {
          id: session.id,
          tenantId,
          status: LiveCameraSessionStatus.STARTING,
          leaseOwner,
        },
        data: { journeyId },
      });
      if (linked.count === 0) {
        try {
          await this.journeys.abortShadowJourney(
            tenantId,
            journeyId,
            STOPPED_DURING_START,
            actorId,
            { exitAt: this.now() },
          );
        } catch (abortError) {
          if (!(abortError instanceof ConflictException)) {
            this.logger.warn(
              `live session ${session.id} could not abort its raced ` +
                `startup journey (${classifyError(abortError)})`,
            );
          }
        }
        return this.byId(tenantId, session.id);
      }
      const promoted = await this.prisma.liveCameraSession.updateMany({
        where: {
          id: session.id,
          tenantId,
          status: LiveCameraSessionStatus.STARTING,
          leaseOwner,
        },
        data: { status: LiveCameraSessionStatus.RUNNING },
      });
      if (promoted.count === 0) {
        // A stop() raced between link and promote. The journey IS linked,
        // but the racing finalizer may have read the row BEFORE the link
        // landed (and closed nothing) — abort it ourselves; if the
        // finalizer did close it first, this conflicts harmlessly.
        try {
          await this.journeys.abortShadowJourney(
            tenantId,
            journeyId,
            STOPPED_DURING_START,
            actorId,
            { exitAt: this.now() },
          );
        } catch (abortError) {
          if (!(abortError instanceof ConflictException)) {
            this.logger.warn(
              `live session ${session.id} could not abort its raced ` +
                `startup journey (${classifyError(abortError)})`,
            );
          }
        }
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

  /**
   * Reclaim a crash-leftover session (Codex P1): active row, no local
   * loop, heartbeat expired. The claim is an ATOMIC conditional write on
   * (active status AND expired heartbeat) — a still-live loop in another
   * process keeps beating and the claim matches nothing. The claim moves
   * the row to STOPPING (unique still held) so the journey is closed
   * BEFORE the terminal write frees the camera; a journey-closure failure
   * leaves the row STOPPING for stop()'s retry path instead of
   * terminalizing over an OPEN journey. Returns true when fully
   * reclaimed (caller may start fresh).
   */
  private async reclaimStaleSession(
    tenantId: string,
    session: SessionWithSource,
    actorId?: string,
  ): Promise<boolean> {
    const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
    const claimed = await this.prisma.liveCameraSession.updateMany({
      where: {
        id: session.id,
        tenantId,
        status: { in: ACTIVE_SESSION_STATUSES },
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, startedAt: { lt: cutoff } },
        ],
      },
      data: {
        status: LiveCameraSessionStatus.STOPPING,
        errorCode: STALE_RECLAIMED,
        leaseOwner: null,
      },
    });
    if (claimed.count === 0) {
      return false;
    }
    let decision: CustomerJourneyDecision | null = null;
    if (session.journeyId) {
      try {
        const aborted = await this.journeys.abortShadowJourney(
          tenantId,
          session.journeyId,
          STALE_RECLAIMED,
          actorId,
          { exitAt: this.now() },
        );
        decision = aborted.decision;
      } catch (error) {
        if (error instanceof ConflictException) {
          // Already closed — read back whatever it settled on.
          const detail = await this.journeys
            .detail(tenantId, session.journeyId)
            .catch(() => null);
          decision = detail?.decision ?? null;
        } else {
          this.logger.warn(
            `stale live session ${session.id} journey abort failed ` +
              `(${classifyError(error)}) — left STOPPING for retry`,
          );
          return false;
        }
      }
    }
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: session.id,
        tenantId,
        status: LiveCameraSessionStatus.STOPPING,
      },
      data: {
        status: LiveCameraSessionStatus.ERROR,
        stoppedAt: this.now(),
        decision,
      },
    });
    return true;
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
    // RUNNING or STOPPING: a stop() moves the row to STOPPING while the
    // loop drains — beats and counter persists from the draining loop
    // must still land (Codex P1: counters persist before STOPPED).
    const LOOP_WRITABLE_STATUSES = [
      LiveCameraSessionStatus.RUNNING,
      LiveCameraSessionStatus.STOPPING,
    ];
    const beat = async (): Promise<void> => {
      const alive = await this.prisma.liveCameraSession
        .updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: LOOP_WRITABLE_STATUSES },
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
            status: { in: LOOP_WRITABLE_STATUSES },
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
        const sampled = await this.sampler.sampleFrame(
          tenantId,
          context.credentialRef,
          {
            width: LIVE_ANALYSIS_GEOMETRY.width,
            height: LIVE_ANALYSIS_GEOMETRY.height,
            timeoutMs: Math.min(context.frameIntervalMs * 2, 10_000),
          },
        );
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
            ).catch(async (error) => {
              // One window's failure never ends the session, but it must
              // FAIL CLOSED (Codex P1): a DETECTED interaction that could
              // not be processed is recorded durably, and finalization
              // marks the journey review-required so the session can
              // never end READY_TO_SETTLE_SHADOW.
              this.logger.warn(
                `live session ${sessionId} window failed (${classifyError(error)})`,
              );
              await this.prisma.liveCameraSession
                .updateMany({
                  where: {
                    id: sessionId,
                    tenantId,
                    status: { in: LOOP_WRITABLE_STATUSES },
                    leaseOwner,
                  },
                  data: { errorCode: WINDOW_PROCESS_FAILED },
                })
                .catch(() => null);
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
    // PENDING MOTION AT STOP (Codex P1): an interaction still in progress
    // when the session ends (manual stop or auto-stop) has no closed
    // window yet — it must not vanish. Fail closed: record a
    // review-required marker on the journey so reconciliation lands on
    // NEEDS_EVENT_REVIEW, never READY_TO_SETTLE_SHADOW over a dropped
    // burst. A quiet tail changes nothing.
    const exitSamples = motionSamples(buffer, LIVE_ANALYSIS_GEOMETRY, zone);
    const trailing = exitSamples[exitSamples.length - 1];
    const lastMs = trailing?.timestampMs ?? 0;
    const openBurst =
      (trailing !== undefined &&
        trailing.motionScore >= DEFAULT_EVENT_WINDOW_CONFIG.minScore) ||
      extractEventWindows(exitSamples, DEFAULT_EVENT_WINDOW_CONFIG).some(
        (window) =>
          window.endMs > processedUpToMs && window.endMs >= lastMs,
      );
    if (openBurst && context.journeyId) {
      try {
        await this.journeys.appendEvent(
          tenantId,
          context.journeyId,
          {
            eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
            occurredAt: new Date(startedAtMs + lastMs).toISOString(),
            sourceType: 'LIVE_SHADOW',
            note: PENDING_MOTION_AT_STOP,
          },
          actorId,
        );
        counters.reviewNeeded += 1;
        await persist();
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          this.logger.warn(
            `live session ${sessionId} could not record pending motion ` +
              `(${classifyError(error)})`,
          );
        }
      }
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
      // FAIL CLOSED for detected-but-unprocessed windows (Codex P1): the
      // durable WINDOW_PROCESS_FAILED code means an interaction was seen
      // and lost — mark the journey review-required BEFORE the exit so
      // reconciliation can never land on READY_TO_SETTLE_SHADOW.
      if (session.errorCode === WINDOW_PROCESS_FAILED) {
        try {
          await this.journeys.appendEvent(
            tenantId,
            session.journeyId,
            {
              eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
              occurredAt: stoppedAt.toISOString(),
              sourceType: 'LIVE_SHADOW',
              note: WINDOW_PROCESS_FAILED,
            },
            actorId,
          );
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            this.logger.warn(
              `live session ${sessionId} could not record failed window ` +
                `(${classifyError(error)})`,
            );
          }
        }
      }
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
          // RETRYABLE (Codex P1): never a terminal session status over an
          // OPEN journey — the row stays STOPPING with a controlled code
          // and a later stop() retries the closure.
          this.logger.warn(
            `live session ${sessionId} journey exit failed (${classifyError(error)})`,
          );
          await this.prisma.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: NON_TERMINAL_SESSION_STATUSES },
              ...(options?.leaseOwner
                ? { leaseOwner: options.leaseOwner }
                : {}),
            },
            data: {
              status: LiveCameraSessionStatus.STOPPING,
              errorCode: JOURNEY_FINALIZE_RETRY,
              leaseOwner: null,
            },
          });
          return;
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
    if (
      !session ||
      session.status === LiveCameraSessionStatus.STOPPED ||
      session.status === LiveCameraSessionStatus.ERROR
    ) {
      return;
    }
    const journeyId = options?.journeyId ?? session.journeyId ?? null;
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
          // RETRYABLE (Codex P1): keep the ORIGINAL failure code (its
          // abort intent survives for the retry) but stay non-terminal —
          // a later stop() re-runs the abort and only then terminalizes.
          this.logger.warn(
            `live session ${sessionId} journey abort failed (${classifyError(error)})`,
          );
          await this.prisma.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: NON_TERMINAL_SESSION_STATUSES },
              ...(options?.leaseOwner
                ? { leaseOwner: options.leaseOwner }
                : {}),
            },
            data: {
              status: LiveCameraSessionStatus.STOPPING,
              errorCode,
              leaseOwner: null,
            },
          });
          return;
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
  /** Overridable for deterministic specs. */
  protected drainTimeoutMs(): number {
    return LIVE_STOP_DRAIN_TIMEOUT_MS;
  }

  /** true = the promise settled inside the bound; false = timed out. */
  private awaitWithTimeout(
    promise: Promise<unknown> | undefined,
    ms: number,
  ): Promise<boolean> {
    if (!promise) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      const settle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      void promise.then(settle, settle);
    });
  }

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
      // DRAIN BEFORE STOPPED (Codex P1): signal the loop and WAIT for it
      // to finish its in-flight window processing and its own
      // finalization (counters persisted, pending-motion checked, journey
      // closed) — bounded. A drain timeout fails closed: the journey is
      // aborted, never reported READY_TO_SETTLE_SHADOW over half-done
      // work.
      controller.stopRequested = true;
      const drained = await this.awaitWithTimeout(
        this.loopPromises.get(sessionId),
        this.drainTimeoutMs(),
      );
      if (!drained) {
        await this.finalizeError(
          tenantId,
          sessionId,
          WINDOW_DRAIN_TIMEOUT,
          actorId,
        );
      }
      return this.byId(tenantId, sessionId);
    }
    // Dead-loop takeover (process restarted, or a prior finalization left
    // the row STOPPING for retry): route by the stored code — abort-intent
    // codes re-run the abort; stop-intent codes (finalize-retry, failed
    // window) re-run the normal exit path, which also appends the
    // review-required marker for failed windows.
    const code = session.errorCode;
    if (code && !STOP_INTENT_CODES.includes(code)) {
      await this.finalizeError(tenantId, sessionId, code, actorId);
    } else {
      await this.finalizeStopped(tenantId, sessionId, actorId);
    }
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
