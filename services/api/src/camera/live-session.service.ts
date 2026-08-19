import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * LIFECYCLE INVARIANTS (Codex P1, lifecycle simplification):
 *   A. A session becomes terminal (STOPPED/ERROR) only after its linked
 *      journey is verifiably closed — enforced by the ONE finalizer.
 *   B. Only the current lease owner mutates counters, appends evidence
 *      or journey events, or terminalizes the session.
 *   C. A process never finalizes a session owned by a FRESH remote
 *      owner: it may only request STOPPING and step aside.
 *   D. Detected-but-unprocessed windows, failed window processing,
 *      pending motion at stop, and failed marker appends can never end
 *      READY_TO_SETTLE_SHADOW — enforced by durable intents + the
 *      decision guard.
 *   E. Fail-closed intents are DURABLE and ADDITIVE rows
 *      (LiveCameraSessionFinalizationIntent), never a single
 *      overwritable errorCode. errorCode is advisory display only.
 *   F. No mandatory write is swallowed: a failure stops or parks the
 *      flow retryably; it never proceeds to a normal exit.
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
 * DURABLE FINALIZATION INTENT REASONS — the controlled vocabulary of
 * LiveCameraSessionFinalizationIntent.reason (mirrored by the DB CHECK).
 * Intents are ADDITIVE: several may coexist (a failed window AND pending
 * motion), none is ever overwritten or deleted, and the finalizer must
 * MATERIALIZE every unmaterialized one before the journey may exit. A
 * session with any intent can never conclude READY_TO_SETTLE_SHADOW.
 */
export const FINALIZATION_INTENT_REASONS = [
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'WINDOW_DETECTED_NOT_PROCESSED',
  'LIVE_WINDOW_DRAIN_TIMEOUT',
  'STARTUP_FINALIZATION_REQUIRED',
  'STALE_SESSION_RECLAIMED',
  'LIVE_FRAME_SCREENING_UNAVAILABLE',
  'LIVE_FRAME_SENSITIVE_CONTENT',
  'JOURNEY_FINALIZATION_RETRY_REQUIRED',
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW',
] as const;

export type FinalizationIntentReason =
  (typeof FINALIZATION_INTENT_REASONS)[number];

/** Intent reasons that MATERIALIZE as REVIEW_REQUIRED journey events (a
 *  dropped/pending/unscreened interaction must be visible to the fold).
 *  Lifecycle reasons (stale reclaim, startup cleanup, drain timeout,
 *  finalization retry) fail closed through the ABORT path instead — a
 *  review marker would only add noise to a journey that ends FAILED. */
const REVIEW_MARKER_REASONS: ReadonlySet<string> = new Set([
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'WINDOW_DETECTED_NOT_PROCESSED',
  'LIVE_FRAME_SCREENING_UNAVAILABLE',
  'LIVE_FRAME_SENSITIVE_CONTENT',
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW',
]);

/**
 * Controlled error codes — ADVISORY DISPLAY ONLY since the lifecycle
 * simplification (the durable safety state lives in the intent rows).
 * The ONLY strings that may land in LiveCameraSession.errorCode from
 * these paths; raw exception text never persists.
 */
export const LIVE_SESSION_ERROR_CODES = [
  'LIVE_SESSION_STOPPED_DURING_START',
  'LIVE_SESSION_STALE_RECLAIMED',
  'JOURNEY_FINALIZE_RETRY',
  'LIVE_WINDOW_DRAIN_TIMEOUT',
  'LIVE_WINDOW_PROCESS_FAILED',
  'PENDING_MOTION_AT_STOP',
  'PRE_LINK_STOP_RETRY_REQUIRED',
] as const;

/** Journey review marker for DETECTED live work (Phase 13 review-first,
 *  Codex P1): every live session that detected ANY motion window —
 *  including fully processed AUTO_PROPOSE windows — must carry this
 *  REVIEW_REQUIRED marker on its journey BEFORE the exit, so the
 *  JOURNEY's own fold (not just the session snapshot) lands in review. */
export const DETECTED_WORK_REVIEW_MARKER =
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW';
/** The SAME string as a durable additive intent, written at DETECTION
 *  TIME — before any fusion run or journey append — so review-first
 *  never depends on the best-effort counter persist (Codex P1). */
const DETECTED_WORK_INTENT: FinalizationIntentReason =
  'LIVE_SESSION_DETECTED_WORK_REQUIRES_REVIEW';

/** Advisory code stamped when the bare pre-link remnant's terminal write
 *  failed: the row parks unowned + mode STOP so the NEXT stop() claims
 *  and terminalizes it immediately (no five-minute stale wait). */
const PRE_LINK_STOP_RETRY = 'PRE_LINK_STOP_RETRY_REQUIRED';

const STOPPED_DURING_START = 'LIVE_SESSION_STOPPED_DURING_START';
const STALE_RECLAIMED = 'LIVE_SESSION_STALE_RECLAIMED';
/** The durable intent counterpart of the STALE_RECLAIMED errorCode. */
const STALE_RECLAIMED_INTENT: FinalizationIntentReason =
  'STALE_SESSION_RECLAIMED';
const JOURNEY_FINALIZE_RETRY = 'JOURNEY_FINALIZE_RETRY';
const WINDOW_DRAIN_TIMEOUT = 'LIVE_WINDOW_DRAIN_TIMEOUT';
const WINDOW_PROCESS_FAILED = 'LIVE_WINDOW_PROCESS_FAILED';
const PENDING_MOTION_AT_STOP = 'PENDING_MOTION_AT_STOP';
const WINDOW_NOT_PROCESSED = 'WINDOW_DETECTED_NOT_PROCESSED';
const STARTUP_FINALIZATION = 'STARTUP_FINALIZATION_REQUIRED';
const FINALIZATION_RETRY = 'JOURNEY_FINALIZATION_RETRY_REQUIRED';

/** Advisory errorCodes whose retry path is a normal STOP finalization
 *  (exit + reconcile) rather than an abort. */
const STOP_INTENT_CODES: readonly string[] = [
  JOURNEY_FINALIZE_RETRY,
  WINDOW_PROCESS_FAILED,
  PENDING_MOTION_AT_STOP,
];

/** Thrown INSIDE the atomic create+link transaction when the session was
 *  concurrently finalized — rolls the journey creation back so nothing
 *  ever exists unlinked. Internal control flow, never surfaces. */
class StartupRaceRollback extends Error {
  constructor() {
    super('startup race — journey creation rolled back');
  }
}

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

/** Per-stage timing statistics (Phase 14) — controlled numeric
 *  aggregates only; never URLs, credentials, or free text. */
export interface LiveStageStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface LivePerformanceSnapshot {
  fastMode: boolean;
  stages: Record<string, LiveStageStats>;
}

export interface LiveSessionDetail extends LiveSessionView {
  eventWindows: EventWindow[];
  performance: LivePerformanceSnapshot | null;
}

/** Bound on retained samples per stage — the loop's memory stays fixed
 *  no matter how long the session runs (oldest samples roll off). */
export const LIVE_PERF_MAX_SAMPLES = 500;

/** NEAREST-RANK percentiles (Codex P2): index = ceil(q·n) − 1, clamped
 *  to [0, n−1] — an integral q·n selects the exact rank (p95 over 20
 *  samples is the 19th smallest, index 18 — NOT the max). Exported for
 *  direct unit testing. */
export function summarizeSamples(samples: number[]): LiveStageStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(q * sorted.length) - 1),
      )
    ] ?? 0;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    avgMs: sorted.length ? Math.round(total / sorted.length) : 0,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
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
    performance:
      session.performance && typeof session.performance === 'object'
        ? (session.performance as unknown as LivePerformanceSnapshot)
        : null,
  };
}

const SOURCE_INCLUDE = {
  cameraSource: { select: { name: true, sourceType: true } },
} as const;

@Injectable()
export class LiveSessionService {
  private readonly logger = new Logger(LiveSessionService.name);

  /** In-process loop controllers — stop() signals through here when the
   *  loop is alive in THIS process. The controller stays registered
   *  until the loop's FINALIZATION completes or parks (Invariant A/C):
   *  a concurrent stop must await it, never double-finalize. It carries
   *  the loop's lease token so stop() can acquire the drain lease and
   *  the timeout path can REVOKE it — both atomically, owner-predicated. */
  private readonly loops = new Map<
    string,
    { stopRequested: boolean; leaseOwner: string }
  >();

  /** Loop completion promises — awaited by stop()'s drain and by the
   *  awaitLoop test hook. */
  private readonly loopPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: CameraSourcesService,
    private readonly sampler: RtspFrameSampler,
    private readonly fusion: PickupFusionService,
    private readonly journeys: JourneyService,
    // Optional so existing test harnesses keep constructing the service
    // without a config stub; production DI always provides it.
    private readonly config?: ConfigService,
  ) {}

  /** Phase 14 — CV_LIVE_FAST_MODE (observability stamp only here; the
   *  actual screening-pass skip lives in the fusion service). */
  private liveFastMode(): boolean {
    return (
      (this.config?.get<string>('CV_LIVE_FAST_MODE') ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

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

  // ------------------------------------------------------------------
  // Durable additive finalization intents (Invariant E)
  // ------------------------------------------------------------------

  /**
   * MANDATORY durable intent write (classification B). Idempotent: the
   * (liveSessionId, reason) unique makes a repeat add a no-op success.
   * ANY other failure THROWS — callers must stop or park, never proceed
   * into a normal finalization over a lost intent (Invariant F).
   */
  private async addIntent(
    tenantId: string,
    sessionId: string,
    reason: FinalizationIntentReason,
    /** Optional transaction client — the takeover/claim paths write the
     *  intent ATOMICALLY with the lease revocation + mode/code stamp
     *  (Codex P1: no partial revocation may commit). */
    db: Pick<
      Prisma.TransactionClient,
      'liveCameraSessionFinalizationIntent'
    > = this.prisma,
  ): Promise<void> {
    try {
      await db.liveCameraSessionFinalizationIntent.create({
        data: { tenantId, liveSessionId: sessionId, reason },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return; // already recorded — additive and idempotent
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // THE finalizer (Invariants A–D). The ONLY code that exits or aborts
  // the session's journey, writes STOPPED/ERROR/stoppedAt/decision, or
  // releases the lease.
  // ------------------------------------------------------------------

  /**
   * Finalize a live session SAFELY, or park it retryably, or refuse.
   *
   * Ownership rules:
   *  - `ownerToken` set → the row must still carry that lease (the
   *    caller is the loop / the starter); otherwise the lease was lost
   *    and NOTHING is touched.
   *  - `ownerToken` null → the row must be UNOWNED (parked or claimed);
   *    a fresh foreign lease is only ever sent a STOPPING request. A
   *    stuck local loop is handled by REVOKING its lease atomically
   *    FIRST (stop()'s drain-timeout path) — there is no ownership
   *    bypass, so every terminal/park write carries a lease predicate.
   *
   * Sequence: re-read → ownership → counter-gap intent → materialize
   * every unmaterialized intent as a REVIEW_REQUIRED journey marker →
   * close the journey (exit for mode 'stop', abort otherwise) → decision
   * guard → terminal CAS. Every mandatory failure parks the row in
   * STOPPING with a JOURNEY_FINALIZATION_RETRY_REQUIRED intent (or, if
   * even that cannot persist, THROWS leaving the row owned and
   * non-terminal for stale reclaim).
   */
  private async finalizeLiveSessionSafely(
    tenantId: string,
    sessionId: string,
    options: {
      ownerToken: string | null;
      mode: 'stop' | 'error';
      code?: string | null;
      actorId?: string;
    },
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
    // Ownership (Invariants B/C).
    const rowOwner = session.leaseOwner ?? null;
    if (options.ownerToken !== null) {
      if (rowOwner !== options.ownerToken) {
        this.logger.warn(
          `live session ${sessionId} lease lost — finalization refused`,
        );
        return;
      }
    } else if (rowOwner !== null) {
      const heartbeatMs = (session.heartbeatAt ?? session.startedAt).getTime();
      if (this.now().getTime() - heartbeatMs < LIVE_SESSION_STALE_MS) {
        // FRESH remote owner: request the stop, never finalize here.
        await this.prisma.liveCameraSession
          .updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: ACTIVE_SESSION_STATUSES },
              leaseOwner: rowOwner,
            },
            data: { status: LiveCameraSessionStatus.STOPPING },
          })
          .catch(() => null);
        return;
      }
      // Stale but unclaimed — the caller must claim atomically first.
      return;
    }
    const stoppedAt = this.now();
    const ownershipWhere =
      options.ownerToken !== null
        ? { leaseOwner: options.ownerToken }
        : { leaseOwner: null };

    /** Park retryably: STOPPING + advisory code + DURABLE finalization
     *  MODE + FINALIZATION_RETRY intent. The mode column (never the
     *  advisory code, never an intent reason) is what the retry uses to
     *  re-enter with the SAME closure semantics — a marker-append
     *  failure during an ERROR finalization must not resume as a clean
     *  STOP (Codex P1). A park that cannot persist its intent THROWS —
     *  the row stays owned and non-terminal for stale reclaim. */
    const park = async (advisoryCode: string): Promise<void> => {
      await this.addIntent(tenantId, sessionId, FINALIZATION_RETRY);
      await this.prisma.liveCameraSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          status: { in: NON_TERMINAL_SESSION_STATUSES },
          ...ownershipWhere,
        },
        data: {
          status: LiveCameraSessionStatus.STOPPING,
          errorCode: advisoryCode,
          finalizationMode: options.mode === 'stop' ? 'STOP' : 'ERROR',
          leaseOwner: null,
        },
      });
    };

    // Counter-gap intent (Invariant D): a detected window that never
    // processed must be durably visible even when no path recorded it.
    const counterGap =
      session.eventWindowsDetected > session.eventWindowsProcessed;
    if (counterGap) {
      await this.addIntent(tenantId, sessionId, WINDOW_NOT_PROCESSED);
    }
    // REVIEW-FIRST (Phase 13 correction): ANY detected live motion means
    // the session's outcome is a review outcome — a live RTSP session may
    // conclude READY_TO_SETTLE_SHADOW only when it detected NOTHING and
    // carries no intent. Processed-and-clean is still review-first for
    // this phase.
    let suppressReady = counterGap || session.eventWindowsDetected > 0;
    const intents =
      await this.prisma.liveCameraSessionFinalizationIntent.findMany({
        where: { tenantId, liveSessionId: sessionId },
      });
    // ANY recorded intent forbids READY (Invariant D): an intent exists
    // only because something abnormal happened (dropped window, pending
    // motion, stale reclaim, failed mandatory write, …) — a session that
    // needed one never concludes clean, missing errorCode or not.
    if (intents.length > 0) {
      suppressReady = true;
    }

    // DETECTED-WORK MARKER (Phase 13 review-first, Codex P1): a live
    // session that detected ANY window — including ones that processed
    // cleanly to AUTO_PROPOSE — persists a review-required marker on the
    // JOURNEY itself before the exit, so the journey's OWN fold decides
    // review, not just the session's copied snapshot. A failed append
    // parks the finalization retryably (mandatory write, never
    // swallowed); an already-closed journey falls to the decision guard.
    if (session.journeyId && session.eventWindowsDetected > 0) {
      try {
        await this.ensureReviewMarker(
          tenantId,
          session.journeyId,
          DETECTED_WORK_REVIEW_MARKER,
          stoppedAt,
          options.actorId,
        );
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          this.logger.warn(
            `live session ${sessionId} could not persist its detected-` +
              `work review marker (${classifyError(error)}) — parked`,
          );
          await park(
            options.mode === 'stop'
              ? JOURNEY_FINALIZE_RETRY
              : (options.code ?? JOURNEY_FINALIZE_RETRY),
          );
          return;
        }
        suppressReady = true;
      }
    }

    // MATERIALIZE every unmaterialized marker-class intent BEFORE the
    // exit — the fold must see the dropped/pending interaction.
    // Lifecycle-class intents (retry bookkeeping, reclaim, drain) carry
    // no marker; their fail-closed effect is the abort path itself.
    if (session.journeyId) {
      for (const intent of intents.filter((row) => !row.materializedAt)) {
        if (REVIEW_MARKER_REASONS.has(intent.reason)) {
          try {
            await this.ensureReviewMarker(
              tenantId,
              session.journeyId,
              intent.reason,
              stoppedAt,
              options.actorId,
            );
          } catch (error) {
            if (!(error instanceof ConflictException)) {
              this.logger.warn(
                `live session ${sessionId} could not materialize ` +
                  `${intent.reason} (${classifyError(error)}) — parked`,
              );
              // Advisory code: keep the ORIGINAL error reason on error
              // finalizations — the marker's reason lives durably in its
              // intent row and must not mask what failed (Codex P1).
              await park(
                options.mode === 'stop'
                  ? intent.reason
                  : (options.code ?? intent.reason),
              );
              return;
            }
            // Journey already closed — the marker can never land in the
            // fold, so the DECISION GUARD below must forbid READY.
            suppressReady = true;
          }
        }
        await this.prisma.liveCameraSessionFinalizationIntent
          .updateMany({
            where: { id: intent.id, tenantId },
            data: { materializedAt: stoppedAt },
          })
          .catch(() => null); // re-materializing later is harmless (idempotent markers)
      }
    }

    // Close the journey (Invariant A). Exit for a clean stop; abort for
    // error/reclaim/drain-timeout paths.
    let decision: CustomerJourneyDecision | null = null;
    if (session.journeyId) {
      try {
        if (options.mode === 'stop') {
          const exited = await this.journeys.exit(
            tenantId,
            session.journeyId,
            options.actorId,
            // The finalizer is the ONE caller allowed to close a
            // live-owned journey — generic exits are rejected while the
            // session is non-terminal (Codex P1).
            { exitAt: stoppedAt, viaLiveSessionFinalizer: true },
          );
          decision = exited.decision;
        } else {
          const aborted = await this.journeys.abortShadowJourney(
            tenantId,
            session.journeyId,
            options.code ?? 'LIVE_SESSION_ERROR',
            options.actorId,
            { exitAt: stoppedAt },
          );
          decision = aborted.decision;
        }
      } catch (error) {
        if (error instanceof ConflictException) {
          const detail = await this.journeys
            .detail(tenantId, session.journeyId)
            .catch(() => null);
          decision = detail?.decision ?? null;
        } else {
          this.logger.warn(
            `live session ${sessionId} journey closure failed ` +
              `(${classifyError(error)}) — parked`,
          );
          await park(
            options.mode === 'stop'
              ? JOURNEY_FINALIZE_RETRY
              : (options.code ?? JOURNEY_FINALIZE_RETRY),
          );
          return;
        }
      }
    }

    // DECISION GUARD (Invariant D, defense in depth): a counter gap or a
    // marker-class intent that could not land in the fold forbids
    // READY_TO_SETTLE_SHADOW on the session snapshot no matter what the
    // journey settled on. Materialized markers already steer the fold to
    // review; lifecycle intents fail closed through the abort path.
    if (
      decision === CustomerJourneyDecision.READY_TO_SETTLE_SHADOW &&
      suppressReady
    ) {
      this.logger.warn(
        `live session ${sessionId} decision guard: READY suppressed`,
      );
      decision = CustomerJourneyDecision.NEEDS_EVENT_REVIEW;
    }

    // Terminal CAS (Invariant A): conditional on the journey link as
    // read and on ownership — a link or owner that changed since voids
    // the write and the row stays retryable.
    await this.prisma.liveCameraSession.updateMany({
      where: {
        id: sessionId,
        tenantId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
        journeyId: session.journeyId,
        ...ownershipWhere,
      },
      data: {
        status:
          options.mode === 'stop'
            ? LiveCameraSessionStatus.STOPPED
            : LiveCameraSessionStatus.ERROR,
        ...(options.code !== undefined ? { errorCode: options.code } : {}),
        stoppedAt,
        decision,
        finalizationMode: null,
        leaseOwner: null,
      },
    });
  }

  async start(
    tenantId: string,
    cameraSourceId: string,
    input: {
      frameIntervalMs?: number | null;
      /** INTERNAL (pilot runner only, never DTO-reachable): hard frame
       *  budget enforced INSIDE the sampling loop — the loop requests
       *  its own stop the moment this many frames have been persisted,
       *  so a polling cadence can never overshoot the budget. */
      pilotFrameBudget?: number | null;
      /** INTERNAL (pilot runner only): absolute deadline (now()-clock
       *  epoch ms) enforced INSIDE the sampling loop — the loop stops
       *  itself when reached, deadline-aware sleeps included. */
      pilotDeadlineAtMs?: number | null;
      /** INTERNAL (pilot runner only, Codex P1): CREATE-ONLY start. A
       *  pilot may poll/stop exclusively a session THIS call created,
       *  so every idempotent existing-session return below becomes a
       *  controlled 409 (LIVE_PILOT_SESSION_ALREADY_ACTIVE) instead —
       *  ownership is atomic (DB partial unique is the race backstop),
       *  never inferred from timestamps. */
      requireNewSession?: boolean;
    },
    actorId?: string,
  ): Promise<LiveSessionDetail> {
    const refuseExisting = (): never => {
      throw new ConflictException(
        'camera source already has an active live session ' +
          '(LIVE_PILOT_SESSION_ALREADY_ACTIVE)',
      );
    };
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
      // CREATE-ONLY pilot start (Codex P1): ANY existing non-terminal
      // session — fresh, stale, local, or remote — refuses BEFORE any
      // branch below can touch it. A pilot must never stop, reclaim,
      // finalize, or mutate a pre-existing session in any way; stale
      // reclaim in particular would mark an unrelated operator session
      // STOPPING and close its journey. Normal starts keep the full
      // reclaim behavior unchanged.
      if (input.requireNewSession) {
        refuseExisting();
      }
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
        active.id,
        actorId,
      );
      if (!reclaimed) {
        // Lost the reclaim race (a real loop beat us, or another start
        // reclaimed first) or the cleanup parked retryably — the row's
        // CURRENT state is the answer.
        return this.byId(tenantId, active.id);
      }
      // Reclaim complete (terminal, journey closed): fall through to a
      // fresh start — the partial unique is free again.
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
          // Phase 14 (Codex P2): fast mode is a fact about THIS session,
          // stamped at creation — never inferred later from the current
          // environment (a legacy row without the stamp reads UNKNOWN).
          performance: {
            fastMode: this.liveFastMode(),
            stages: {},
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // RACE BACKSTOP: the partial unique (one non-terminal session per
        // source) means a concurrent start won. For a normal start its
        // session IS the session; a CREATE-ONLY pilot start refuses —
        // the winner is someone else's session (Codex P1: this DB
        // constraint is the atomic ownership arbiter, not timestamps).
        if (input.requireNewSession) {
          refuseExisting();
        }
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

    // ATOMIC journey create + session link (Codex P1, lifecycle
    // simplification): ONE transaction re-checks that this attempt still
    // owns a STARTING row, opens the journey (validations + journey +
    // ENTRY on the SAME tx), and links it — so a journey either exists
    // LINKED or does not exist at all. A racing stop() that finalized
    // the row makes the guard or the link miss and the whole creation
    // ROLLS BACK: nothing to abort, nothing to orphan, no best-effort
    // recovery lattice.
    let journeyId: string | null = null;
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const current = await tx.liveCameraSession.findFirst({
          where: { id: session.id, tenantId },
          select: { status: true, leaseOwner: true },
        });
        if (
          !current ||
          current.status !== LiveCameraSessionStatus.STARTING ||
          current.leaseOwner !== leaseOwner
        ) {
          return { raced: true as const };
        }
        const opened = await this.journeys.openJourneyInTransaction(
          tx,
          tenantId,
          { locationId: source.locationId, unitId: source.unitId },
          actorId,
          { entryAt: session.startedAt },
        );
        const linked = await tx.liveCameraSession.updateMany({
          where: {
            id: session.id,
            tenantId,
            status: LiveCameraSessionStatus.STARTING,
            leaseOwner,
          },
          data: { journeyId: opened.journeyId },
        });
        if (linked.count === 0) {
          // The row changed between the guard read and the link write —
          // roll the journey creation back with it.
          throw new StartupRaceRollback();
        }
        return { raced: false as const, journeyId: opened.journeyId };
      });
      if (outcome.raced) {
        // A stop landed BEFORE the journey existed (Codex P1): finalize
        // the bare row NOW — releasing the lease and the one-active-per-
        // source slot immediately — instead of abandoning a STOPPING row
        // to the five-minute stale reclaim. No journey was created, so
        // this is a stopped-before-start with zero events.
        await this.finalizeStartupRemnant(tenantId, session.id, leaseOwner, actorId);
        return this.byId(tenantId, session.id);
      }
      journeyId = outcome.journeyId;
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
        // A stop() raced between the atomic link and the promote. The
        // journey exists and IS linked — the ordinary finalizer closes
        // it. The intent is MANDATORY (throws on failure, leaving the
        // row owned + linked for stale reclaim / stop() retry).
        await this.addIntent(tenantId, session.id, STARTUP_FINALIZATION);
        await this.finalizeLiveSessionSafely(tenantId, session.id, {
          ownerToken: leaseOwner,
          mode: 'error',
          code: STOPPED_DURING_START,
          actorId,
        });
        return this.byId(tenantId, session.id);
      }
    } catch (error) {
      if (error instanceof StartupRaceRollback) {
        // Rolled back inside the transaction: no journey exists. Same
        // immediate bare-row finalization as the guard race above.
        await this.finalizeStartupRemnant(tenantId, session.id, leaseOwner, actorId);
        return this.byId(tenantId, session.id);
      }
      // The transaction failed (journey creation rolled back with it) or
      // a post-tx mandatory write failed. With no journey there is
      // nothing to close; finalize the bare row as ERROR. With a linked
      // journey (post-tx failures) the finalizer closes or parks.
      await this.finalizeLiveSessionSafely(tenantId, session.id, {
        ownerToken: leaseOwner,
        mode: 'error',
        code: classifyError(error),
        actorId,
      }).catch((finalizeError) => {
        this.logger.error(
          `live session ${session.id} startup finalization failed ` +
            `(${classifyError(finalizeError)}) — left owned for stale ` +
            `reclaim`,
        );
      });
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
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
        frameBudget: input.pilotFrameBudget ?? null,
        deadlineAtMs: input.pilotDeadlineAtMs ?? null,
      },
      actorId,
    ).catch((error) => {
      this.logger.error(
        `live session ${session.id} loop crashed (${classifyError(error)})`,
      );
      return this.finalizeLiveSessionSafely(tenantId, session.id, {
        ownerToken: leaseOwner,
        mode: 'error',
        code: 'LIVE_LOOP_FAILED',
        actorId,
      }).catch(() => undefined);
    });
    this.loopPromises.set(
      session.id,
      loopPromise.then(() => undefined),
    );

    return this.byId(tenantId, session.id);
  }

  /**
   * Finalize a startup remnant: a session row whose start lost a race
   * BEFORE any journey existed (stop landed pre-link, or the atomic
   * create+link rolled back). Runs through the strict finalizer with the
   * startup lease — if the lease is no longer ours (a claimant or the
   * racing stop's own finalization won) the finalizer refuses and the
   * row is left to its current owner. mode 'stop': this is a requested
   * stop with ZERO events, not a runtime error.
   */
  private async finalizeStartupRemnant(
    tenantId: string,
    sessionId: string,
    leaseOwner: string,
    actorId?: string,
  ): Promise<void> {
    try {
      await this.finalizeLiveSessionSafely(tenantId, sessionId, {
        ownerToken: leaseOwner,
        mode: 'stop',
        code: STOPPED_DURING_START,
        actorId,
      });
    } catch (error) {
      // MANDATORY-failure fallback (Codex P1): never leave a FRESH owned
      // STOPPING row with no local loop — a later stop() would read it as
      // a fresh remote owner and wait out the five-minute stale cutoff.
      // Park the bare row UNOWNED with mode STOP + a retry code so the
      // very next stop() claims and terminalizes it immediately.
      this.logger.error(
        `live session ${sessionId} startup-remnant finalization failed ` +
          `(${classifyError(error)}) — parking for immediate retry`,
      );
      try {
        await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
            leaseOwner,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPING,
            leaseOwner: null,
            finalizationMode: 'STOP',
            errorCode: PRE_LINK_STOP_RETRY,
          },
        });
      } catch (parkError) {
        // BOTH mandatory writes failed (Codex P1): NEVER report success
        // over a stuck remnant. The remnant stays retryable CROSS-
        // PROCESS through stop()'s bare-remnant fast path (journeyId
        // null + zero frames is atomically claimable by ANY process, no
        // stale cutoff, no process-local state) — so this request only
        // needs to fail visibly with a controlled error.
        this.logger.error(
          `live session ${sessionId} pre-link retry park failed ` +
            `(${classifyError(parkError)}) — failing the request; the ` +
            `bare remnant is claimable by any process's stop()`,
        );
        throw new ConflictException(
          'live session stop is pending finalization retry ' +
            '(PRE_LINK_STOP_RETRY_REQUIRED)',
        );
      }
    }
  }

  /**
   * Reclaim a crash-leftover session (Codex P1): active row, no local
   * loop, heartbeat expired. The claim is an ATOMIC conditional write on
   * (active status AND expired heartbeat) — a still-live loop in another
   * process keeps beating and the claim matches nothing. After the claim
   * the durable STALE intent is recorded and the finalizer closes the
   * journey using its OWN fresh re-read of the row (a journey the
   * original starter linked between snapshot and claim is therefore
   * still closed). Returns true when the row reached a terminal state
   * (caller may start fresh).
   */
  private async reclaimStaleSession(
    tenantId: string,
    sessionId: string,
    actorId?: string,
  ): Promise<boolean> {
    // ONE transaction: claim + finalizationMode=ERROR + code + durable
    // intent (Codex P1) — the stamp is the journey-level fence, and a
    // failed intent write rolls the whole claim back (nothing partial).
    const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
    let claimed = false;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        const res = await tx.liveCameraSession.updateMany({
          where: {
            id: sessionId,
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
            finalizationMode: 'ERROR',
            leaseOwner: null,
          },
        });
        if (res.count === 0) {
          return false;
        }
        await this.addIntent(tenantId, sessionId, STALE_RECLAIMED_INTENT, tx);
        return true;
      });
    } catch (error) {
      this.logger.warn(
        `stale live session ${sessionId} claim failed ` +
          `(${classifyError(error)}) — nothing claimed, retry later`,
      );
      return false;
    }
    if (!claimed) {
      return false;
    }
    try {
      await this.finalizeLiveSessionSafely(tenantId, sessionId, {
        ownerToken: null,
        mode: 'error',
        code: STALE_RECLAIMED,
        actorId,
      });
    } catch (error) {
      this.logger.warn(
        `stale live session ${sessionId} cleanup failed ` +
          `(${classifyError(error)}) — left STOPPING for retry`,
      );
      return false;
    }
    const after = await this.prisma.liveCameraSession.findFirst({
      where: { id: sessionId, tenantId },
      select: { status: true },
    });
    return (
      after?.status === LiveCameraSessionStatus.ERROR ||
      after?.status === LiveCameraSessionStatus.STOPPED
    );
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
      /** Pilot frame budget (null = unbounded normal session). */
      frameBudget: number | null;
      /** Pilot time budget as an absolute now()-clock deadline (null =
       *  unbounded normal session). */
      deadlineAtMs: number | null;
    },
    actorId?: string,
  ): Promise<void> {
    const controller = { stopRequested: false, leaseOwner };
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

    // Phase 14 — per-stage timing samples (REAL wall clock, deliberately
    // not the overridable now() hook: metrics measure actual latency,
    // and specs assert presence/shape, not durations). Bounded per
    // stage; aggregated to p50/p95/max and persisted best-effort.
    const perf = new Map<string, number[]>();
    const perfSample = (stage: string, ms: number): void => {
      const samples = perf.get(stage) ?? [];
      if (samples.length >= LIVE_PERF_MAX_SAMPLES) {
        samples.shift();
      }
      samples.push(ms);
      perf.set(stage, samples);
    };
    const fastMode = this.liveFastMode();
    const perfSnapshot = (): Prisma.InputJsonValue => {
      const stages: Record<string, LiveStageStats> = {};
      for (const [stage, samples] of perf) {
        stages[stage] = summarizeSamples(samples);
      }
      return { fastMode, stages } as unknown as Prisma.InputJsonValue;
    };

    // RUNNING or STOPPING: a stop() moves the row to STOPPING while the
    // loop drains — counter persists from the draining loop must still
    // land (Codex P1: counters persist before STOPPED).
    const LOOP_WRITABLE_STATUSES = [
      LiveCameraSessionStatus.RUNNING,
      LiveCameraSessionStatus.STOPPING,
    ];
    // The beat is the ownership probe AND the CROSS-PROCESS STOP CHANNEL
    // (Codex P1 round 3): it renews the lease ONLY while the row is
    // RUNNING. A stop endpoint in ANY process marks the row STOPPING
    // while keeping this loop's leaseOwner — the next beat matches
    // nothing, re-reads, recognizes its OWN lease on a STOPPING row as a
    // stop REQUEST, and this loop drains + finalizes as the owner. Any
    // other mismatch (foreign owner, terminal, gone) is a LOST lease:
    // the loop halts with no finalization of its own. Transport failures
    // stay best-effort (classification A) — an unrenewed lease ages into
    // stale-reclaim, which is the safety net.
    const beat = async (): Promise<void> => {
      try {
        const alive = await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: LiveCameraSessionStatus.RUNNING,
            leaseOwner,
          },
          data: { heartbeatAt: this.now() },
        });
        if (alive.count > 0) {
          return;
        }
        const row = await this.prisma.liveCameraSession.findFirst({
          where: { id: sessionId, tenantId },
        });
        if (
          row &&
          row.status === LiveCameraSessionStatus.STOPPING &&
          row.leaseOwner === leaseOwner
        ) {
          // External stop request: drain and finalize as the owner,
          // keeping the lease fresh through the drain so a stale-claimer
          // cannot steal the row mid-finalization.
          controller.stopRequested = true;
          await this.prisma.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: LiveCameraSessionStatus.STOPPING,
              leaseOwner,
            },
            data: { heartbeatAt: this.now() },
          });
          return;
        }
        leaseLost = true;
      } catch {
        // Best-effort: retried on the next beat; staleness backstops.
      }
    };
    const heartbeatTimer = setInterval(() => {
      void beat();
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    /** Persist the loop's counters — conditional on ownership, absolute
     *  values (no read-modify-write races with ourselves). BEST-EFFORT
     *  (classification A): the durable safety state lives in intents. */
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
            performance: perfSnapshot(),
            heartbeatAt: this.now(),
            ...extra,
          },
        })
        .catch(() => null);
      if (written !== null && written.count === 0) {
        leaseLost = true;
      }
    };

    /** Unpersisted MANDATORY intent (classification B): while set,
     *  normal finalization is BLOCKED — the loop retries the durable
     *  write every iteration, and at exit it must leave the row owned
     *  for stale reclaim. Never silently discarded. */
    let unpersistedIntent: FinalizationIntentReason | null = null;

    /** MANDATORY failed-window intent: a DETECTED window whose
     *  processing failed must be durably visible (intent → review marker
     *  before exit). The advisory errorCode is best-effort display. */
    const recordWindowFailure = async (): Promise<void> => {
      try {
        await this.addIntent(tenantId, sessionId, WINDOW_PROCESS_FAILED);
        unpersistedIntent = null;
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
      } catch {
        unpersistedIntent = WINDOW_PROCESS_FAILED;
      }
    };

    /** Retry whatever mandatory intent is still unpersisted — the loop
     *  may never finalize normally while one is pending (Invariant F). */
    const retryUnpersistedIntent = async (): Promise<void> => {
      if (unpersistedIntent === WINDOW_PROCESS_FAILED) {
        await recordWindowFailure();
        return;
      }
      if (unpersistedIntent) {
        const pending = unpersistedIntent;
        try {
          await this.addIntent(tenantId, sessionId, pending);
          if (unpersistedIntent === pending) {
            unpersistedIntent = null;
          }
        } catch {
          // still pending — retried next iteration / blocks finalization
        }
      }
    };

    /** Process one CLOSED window: watermark, counters, fusion + import;
     *  a failure fails CLOSED (durable intent — finalization then marks
     *  the journey review-required, so a dropped interaction can never
     *  end READY_TO_SETTLE_SHADOW). Shared by the in-loop pass and the
     *  final sweep at stop. */
    const handleClosedWindow = async (window: EventWindow): Promise<void> => {
      // MANDATORY DETECTION-TIME FENCE (Codex P1): the durable detected-
      // work intent lands BEFORE any fusion run or journey append —
      // review-first must never depend on the best-effort counter
      // persist. If the intent cannot land, the window is NOT processed
      // and NOT watermarked (the same closed window retries on the next
      // pass), and normal finalization stays blocked (Invariant F).
      try {
        await this.addIntent(tenantId, sessionId, DETECTED_WORK_INTENT);
        if (unpersistedIntent === DETECTED_WORK_INTENT) {
          // A prior skip's pending fence just landed with this attempt.
          unpersistedIntent = null;
        }
      } catch {
        unpersistedIntent = DETECTED_WORK_INTENT;
        return;
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
        perfSample,
      ).catch(async (error) => {
        this.logger.warn(
          `live session ${sessionId} window failed (${classifyError(error)})`,
        );
        await recordWindowFailure();
      });
      // event-to-review latency (Codex P1): measured from the WINDOW
      // CLOSE INSTANT (startedAt + endMs) to review-result completion —
      // including the quiet-sample confirmation delay before the window
      // was even detected, which is real pilot latency. Clamped at 0
      // against clock skew. Uses now() so the whole subtraction shares
      // one clock.
      perfSample(
        'eventToReview',
        Math.max(0, this.now().getTime() - (startedAtMs + window.endMs)),
      );
      await persist();
    };

    // The CONTROLLER stays registered until finalization completes or
    // parks retryable (Codex P1): a concurrent stop() during post-loop
    // persist / sweep / marker / finalize must AWAIT this loop's own
    // finalization, never take the dead-loop path and double-finalize.
    try {
      for (;;) {
        if (controller.stopRequested || leaseLost) {
          break;
        }
        if (this.now().getTime() - startedAtMs >= MAX_LIVE_SESSION_MS) {
          // MVP safety bound — normal stop path.
          break;
        }
        if (unpersistedIntent) {
          // MANDATORY write retry (Invariant F): the pending intent must
          // land before this loop may ever finalize normally.
          await retryUnpersistedIntent();
        }
        // PILOT BUDGETS (Codex P2): frame budget AND time deadline are
        // both checked BEFORE scheduling the next sample — a budget of N
        // never samples frame N+1, and a passed deadline never starts
        // another sample, no matter how coarse any external polling is.
        if (
          context.frameBudget !== null &&
          counters.framesSampled >= context.frameBudget
        ) {
          break;
        }
        if (
          context.deadlineAtMs !== null &&
          this.now().getTime() >= context.deadlineAtMs
        ) {
          break;
        }
        const sampleStart = Date.now();
        const sampled = await this.sampler.sampleFrame(
          tenantId,
          context.credentialRef,
          {
            width: LIVE_ANALYSIS_GEOMETRY.width,
            height: LIVE_ANALYSIS_GEOMETRY.height,
            timeoutMs: Math.min(context.frameIntervalMs * 2, 10_000),
            // Phase 14 (Codex P1): FILE-BACKED dev sources must advance
            // through the video — a per-sample seek position keyed to
            // the sampling timeline. RTSP sources ignore this (a live
            // stream has no seekable timeline).
            seekMs: frameIndex * context.frameIntervalMs,
          },
        );
        perfSample('frameSample', Date.now() - sampleStart);
        if (sampled.ok) {
          // The sampled frame ALWAYS lands, even when a stop arrived while
          // sampling (Codex P1): a quiet frame may be the one that CLOSES
          // a motion burst — dropping it would vanish the interaction.
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
          // Closed windows are processed even under a stop request; only
          // a LOST LEASE halts mid-pass (someone else owns the row).
          const detectStart = Date.now();
          const samples = motionSamples(buffer, LIVE_ANALYSIS_GEOMETRY, zone);
          const closedWindows = extractEventWindows(
            samples,
            DEFAULT_EVENT_WINDOW_CONFIG,
          );
          perfSample('windowDetection', Date.now() - detectStart);
          const lastSampleMs = samples[samples.length - 1]?.timestampMs ?? 0;
          for (const window of closedWindows) {
            if (leaseLost) {
              break;
            }
            if (window.startMs <= processedUpToMs) {
              continue;
            }
            if (window.endMs >= lastSampleMs) {
              continue; // still open — wait for the burst to end
            }
            await handleClosedWindow(window);
          }
        } else {
          consecutiveFailures += 1;
          if (consecutiveFailures >= LIVE_MAX_CONSECUTIVE_SAMPLE_FAILURES) {
            errorCode = sampled.code;
            break;
          }
        }
        if (controller.stopRequested || leaseLost) {
          break;
        }
        // Budget/deadline met exactly at this frame: break NOW (skipping
        // the idle sleep) — the closed-window pass for this frame ran.
        if (
          context.frameBudget !== null &&
          counters.framesSampled >= context.frameBudget
        ) {
          break;
        }
        if (
          context.deadlineAtMs !== null &&
          this.now().getTime() >= context.deadlineAtMs
        ) {
          break;
        }
        // DEADLINE-AWARE sleep (Codex P2): never sleep past the pilot
        // deadline — a 60s frame interval with 1s remaining sleeps 1s,
        // wakes, and exits above instead of stalling into drain timeout.
        const remainingMs =
          context.deadlineAtMs !== null
            ? Math.max(1, context.deadlineAtMs - this.now().getTime())
            : context.frameIntervalMs;
        await this.sleep(Math.min(context.frameIntervalMs, remainingMs));
        await beat();
      }

      if (leaseLost) {
        this.logger.warn(
          `live session ${sessionId} lost its lease — loop stopped without finalizing`,
        );
        return;
      }
      // ATOMIC DRAIN-LEASE VERIFICATION (Codex P1): everything below —
      // counter persist, final sweep, pending-motion intent, journey
      // finalization — mutates state this loop may touch ONLY while it
      // still holds the lease. A refresh that matches nothing OR throws
      // both mean ownership cannot be proven: treat as LOST, drain
      // nothing, mutate nothing (staleness backstops the row).
      try {
        const held = await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            leaseOwner,
            status: { in: LOOP_WRITABLE_STATUSES },
            stoppedAt: null,
          },
          data: { heartbeatAt: this.now() },
        });
        if (held.count === 0) {
          leaseLost = true;
        }
      } catch {
        leaseLost = true;
      }
      if (leaseLost) {
        this.logger.warn(
          `live session ${sessionId} lost its drain lease — loop stopped without finalizing`,
        );
        return;
      }
      await persist();
      if (leaseLost) {
        this.logger.warn(
          `live session ${sessionId} lost its lease — loop stopped without finalizing`,
        );
        return;
      }
      if (errorCode) {
        try {
          await this.finalizeLiveSessionSafely(tenantId, sessionId, {
            ownerToken: leaseOwner,
            mode: 'error',
            code: errorCode,
            actorId,
          });
        } catch (finalizeErr) {
          // An escaping finalization write failure (even the park could
          // not persist) leaves the row owned + non-terminal for stale
          // reclaim (Invariant F).
          this.logger.error(
            `live session ${sessionId} error finalization write failed ` +
              `(${classifyError(finalizeErr)}) — left owned for stale ` +
              `reclaim`,
          );
        }
        return;
      }
      // FINAL SWEEP (Codex P1): a window the newest quiet frame CLOSED
      // just as the stop arrived must not be skipped — process every
      // remaining closed window before finalization.
      const exitSamples = motionSamples(buffer, LIVE_ANALYSIS_GEOMETRY, zone);
      const trailing = exitSamples[exitSamples.length - 1];
      const lastMs = trailing?.timestampMs ?? 0;
      /** A closed FINAL-SWEEP window skipped because the detection-time
       *  fence could not land (Codex P1): the window must not vanish —
       *  once the fence recovers below, it is durably represented by a
       *  WINDOW_DETECTED_NOT_PROCESSED intent before finalization may
       *  continue. */
      let sweepWindowSkipped = false;
      for (const window of extractEventWindows(
        exitSamples,
        DEFAULT_EVENT_WINDOW_CONFIG,
      )) {
        if (leaseLost) {
          break;
        }
        if (window.startMs <= processedUpToMs) {
          continue;
        }
        if (window.endMs >= lastMs) {
          continue; // open at the newest sample — pending-motion below
        }
        await handleClosedWindow(window);
        if (unpersistedIntent === DETECTED_WORK_INTENT) {
          sweepWindowSkipped = true;
        }
      }
      if (leaseLost) {
        return;
      }
      // PENDING MOTION AT STOP (Codex P1): an interaction still in
      // progress when the session ends (manual stop or auto-stop) has no
      // closed window yet — it must not vanish. The DURABLE intent lands
      // FIRST (Invariant E); the finalizer materializes it as a
      // review-required journey marker before the exit. If the intent
      // cannot persist, the loop leaves the row OWNED and non-terminal —
      // stale reclaim aborts the journey (fail-closed by another route).
      const openBurst =
        (trailing !== undefined &&
          trailing.motionScore >= DEFAULT_EVENT_WINDOW_CONFIG.minScore) ||
        extractEventWindows(exitSamples, DEFAULT_EVENT_WINDOW_CONFIG).some(
          (window) =>
            window.endMs > processedUpToMs && window.endMs >= lastMs,
        );
      if (openBurst && context.journeyId) {
        try {
          await this.addIntent(tenantId, sessionId, PENDING_MOTION_AT_STOP);
        } catch {
          this.logger.error(
            `live session ${sessionId} could not persist its ` +
              `pending-motion intent — left owned for stale reclaim`,
          );
          return;
        }
        counters.reviewNeeded += 1;
        await persist({ errorCode: PENDING_MOTION_AT_STOP });
      }
      if (unpersistedIntent) {
        // Last landing attempt for the pending mandatory intent — a
        // normal exit over an unrecorded interaction is forbidden
        // (Invariant F).
        await retryUnpersistedIntent();
      }
      if (unpersistedIntent) {
        this.logger.error(
          `live session ${sessionId} could not persist its mandatory ` +
            `${unpersistedIntent} intent — left owned for stale reclaim`,
        );
        return;
      }
      if (sweepWindowSkipped) {
        // The detection fence RECOVERED but a closed final-sweep window
        // was never processed (no fusion run, no journey append). The
        // generic detected-work marker alone must not stand in for it —
        // the SPECIFIC unprocessed-window intent lands durably before
        // finalization may continue; if it cannot, the row stays owned
        // and non-terminal for stale reclaim (Invariant F).
        try {
          await this.addIntent(tenantId, sessionId, WINDOW_NOT_PROCESSED);
        } catch {
          this.logger.error(
            `live session ${sessionId} could not persist its ` +
              `unprocessed-window intent — left owned for stale reclaim`,
          );
          return;
        }
      }
      try {
        await this.finalizeLiveSessionSafely(tenantId, sessionId, {
          ownerToken: leaseOwner,
          mode: 'stop',
          actorId,
        });
      } catch (finalizeError) {
        this.logger.error(
          `live session ${sessionId} finalization write failed ` +
            `(${classifyError(finalizeError)}) — left owned for stale ` +
            `reclaim`,
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.loops.delete(sessionId);
    }
  }

  /**
   * Idempotently ensure a REVIEW_REQUIRED marker with the given code
   * exists on the journey (tenant-scoped read through the journey
   * service). Throws when the append fails — the finalizer parks the
   * session for stop()'s retry.
   */
  private async ensureReviewMarker(
    tenantId: string,
    journeyId: string,
    code: string,
    occurredAt: Date,
    actorId?: string,
  ): Promise<void> {
    const detail = await this.journeys.detail(tenantId, journeyId);
    const exists = detail.events.some(
      (event) =>
        event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED &&
        event.sourceType === 'LIVE_SHADOW' &&
        event.note === code,
    );
    if (exists) {
      return;
    }
    await this.journeys.appendEvent(
      tenantId,
      journeyId,
      {
        eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
        occurredAt: occurredAt.toISOString(),
        sourceType: 'LIVE_SHADOW',
        note: code,
      },
      actorId,
    );
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
    perfSample?: (stage: string, ms: number) => void,
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
    // Timed in FINALLY (Codex P2): a fusion run that fails after a long
    // stall must still land in the stage stats — hiding slow failures
    // would understate p95/slowestStage exactly when it matters most.
    const fusionStart = Date.now();
    let runId: string;
    try {
      ({ runId } = await this.fusion.runLiveWindow(tenantId, {
        liveSessionId: sessionId,
        locationId: context.locationId,
        unitId: context.unitId,
        frames,
        window: {
          startMs: window.startMs,
          endMs: window.endMs,
          peakMs: window.peakMs,
        },
      }));
    } finally {
      perfSample?.('fusion', Date.now() - fusionStart);
    }
    counters.fusionRunsCompleted += 1;
    const runRow = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, id: runId },
      select: { evidence: true },
    });
    const evidence = runRow?.evidence as
      | {
          vlm?: { invoked?: boolean; status?: string | null };
          stages?: { stage?: string; ms?: number }[];
        }
      | undefined;
    // Fusion's own per-stage timings (detection, crops, barcode, OCR,
    // retrieval, classical, VLM/screen) roll into the session stats —
    // stage NAMES are controlled pipeline identifiers, never free text.
    if (perfSample && Array.isArray(evidence?.stages)) {
      for (const stage of evidence.stages) {
        if (typeof stage?.stage === 'string' && typeof stage.ms === 'number') {
          perfSample(`fusion:${stage.stage}`, stage.ms);
        }
      }
    }
    const vlm = evidence?.vlm;
    if (vlm?.invoked === true) {
      counters.vlmInvoked += 1;
      if (vlm.status !== 'VERDICT') {
        counters.vlmFailed += 1;
      }
    } else {
      counters.vlmSkipped += 1;
    }
    if (context.journeyId) {
      const importStart = Date.now();
      let detail: Awaited<
        ReturnType<JourneyService['appendFromLiveFusionRun']>
      >;
      try {
        detail = await this.journeys.appendFromLiveFusionRun(
          tenantId,
          context.journeyId,
          runId,
          actorId,
          {
            sourceTimeBase: context.startedAt,
            fallbackPeakMs: window.peakMs,
          },
        );
      } finally {
        // Failed imports count too (Codex P2) — see the fusion note.
        perfSample?.('journeyImport', Date.now() - importStart);
      }
      counters.journeyEventsCreated = detail.events.filter(
        (event) => event.sourceType === 'LIVE_SHADOW',
      ).length;
      counters.reviewNeeded = detail.issues.length;
    }
    counters.eventWindowsProcessed += 1;
  }

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

  /**
   * Stop — safe whether the loop is local, remote, dead, or parked. All
   * finalization flows through finalizeLiveSessionSafely; this method
   * only routes: local drain, remote request, stale claim, or retry
   * resume. Stopping a terminal session is idempotent.
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
    // PRE-LINK BARE REMNANT — CROSS-PROCESS (Codex P1): a STARTING/
    // STOPPING row with NO journey and NO sampled frames is a startup
    // remnant. There is no sampler loop, no evidence, and no journey to
    // protect, so ANY process may terminalize it IMMEDIATELY — treating
    // its fresh lease as a remote owner would block the camera for the
    // stale cutoff for nothing. Safe against an in-flight start: the
    // atomic create+link transaction and the promote both CAS on
    // (STARTING + owner), so this claim makes them miss and the startup
    // rolls back journey-less. The claim itself CASes on the row as
    // read; a miss means the row changed (linked, promoted, claimed) —
    // return its current state, never finalize from the stale view.
    if (
      session.journeyId === null &&
      session.framesSampled === 0 &&
      (session.status === LiveCameraSessionStatus.STARTING ||
        session.status === LiveCameraSessionStatus.STOPPING)
    ) {
      try {
        // A count of 0 means the row changed under us (linked, promoted,
        // or claimed elsewhere) — the reload below returns its current
        // state either way; the claim is all-or-nothing.
        await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: {
              in: [
                LiveCameraSessionStatus.STARTING,
                LiveCameraSessionStatus.STOPPING,
              ],
            },
            journeyId: null,
            framesSampled: 0,
            leaseOwner: session.leaseOwner,
            stoppedAt: null,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPED,
            stoppedAt: this.now(),
            leaseOwner: null,
            finalizationMode: null,
            errorCode: session.errorCode ?? STOPPED_DURING_START,
          },
        });
      } catch (error) {
        // MANDATORY terminal write failed — never report success over a
        // stuck remnant; the caller (any process) retries this same path.
        this.logger.error(
          `live session ${sessionId} bare-remnant finalization failed ` +
            `(${classifyError(error)}) — failing the request for retry`,
        );
        throw new ConflictException(
          'live session stop is pending finalization retry ' +
            '(PRE_LINK_STOP_RETRY_REQUIRED)',
        );
      }
      return this.byId(tenantId, sessionId);
    }
    const controller = this.loops.get(sessionId);
    if (controller) {
      // ATOMIC DRAIN-LEASE ACQUISITION (Codex P1): the local loop may
      // drain and finalize ONLY while its lease still stands. The
      // predicate carries the owner token; a miss or a transport failure
      // means the lease is gone (stale claim, park, terminal) — halt the
      // zombie loop but drain nothing, mutate nothing, finalize nothing
      // from the old owner.
      const acquired = await this.prisma.liveCameraSession
        .updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: NON_TERMINAL_SESSION_STATUSES },
            leaseOwner: controller.leaseOwner,
            stoppedAt: null,
          },
          data: {
            status: LiveCameraSessionStatus.STOPPING,
            heartbeatAt: this.now(),
          },
        })
        .catch(() => null);
      if (!acquired || acquired.count === 0) {
        controller.stopRequested = true;
        return this.byId(tenantId, sessionId);
      }
      // DRAIN BEFORE STOPPED (Codex P1): signal the loop and WAIT for it
      // to finish its in-flight window processing and its own
      // finalization (counters persisted, closed windows swept, pending
      // motion recorded, journey closed) — bounded. The controller stays
      // registered through the loop's finalization, so a concurrent
      // stop() awaits the SAME finalization here instead of taking the
      // dead-loop path and double-finalizing. A drain timeout fails
      // closed: durable intent + abort, never READY over half-done work.
      controller.stopRequested = true;
      const drained = await this.awaitWithTimeout(
        this.loopPromises.get(sessionId),
        this.drainTimeoutMs(),
      );
      if (!drained) {
        // ATOMIC LEASE REVOCATION + FENCE (Codex P1): the stuck loop's
        // finalizer may be blocked INSIDE journeys.exit — starting a
        // second finalizer while its lease stands would let whichever
        // completes last win. ONE transaction revokes the lease
        // (owner-predicated CAS) AND stamps finalizationMode=ERROR +
        // the timeout errorCode AND the durable DRAIN_TIMEOUT intent —
        // the stamp is the journey-level fence: the journey's reconcile
        // reads it before committing READY, so the blocked original
        // exit can no longer settle the journey clean. All-or-nothing:
        // a failed intent write rolls the revocation back and the
        // previous owner keeps its lease (retry later); an unowned
        // STOPPING row without mode/code can never exist. Only after
        // the fence commits does the fail-closed finalizer run, as the
        // now-unowned row.
        let revoked = false;
        try {
          revoked = await this.prisma.$transaction(async (tx) => {
            const res = await tx.liveCameraSession.updateMany({
              where: {
                id: sessionId,
                tenantId,
                status: { in: NON_TERMINAL_SESSION_STATUSES },
                leaseOwner: controller.leaseOwner,
                stoppedAt: null,
              },
              data: {
                status: LiveCameraSessionStatus.STOPPING,
                leaseOwner: null,
                finalizationMode: 'ERROR',
                errorCode: WINDOW_DRAIN_TIMEOUT,
              },
            });
            if (res.count === 0) {
              return false;
            }
            await this.addIntent(tenantId, sessionId, WINDOW_DRAIN_TIMEOUT, tx);
            return true;
          });
        } catch (error) {
          this.logger.error(
            `live session ${sessionId} drain-timeout revocation failed ` +
              `(${classifyError(error)}) — owner lease left intact for retry`,
          );
          return this.byId(tenantId, sessionId);
        }
        if (!revoked) {
          // The loop already finalized/parked or a claimant won — never
          // finalize from this stale view.
          return this.byId(tenantId, sessionId);
        }
        try {
          await this.finalizeLiveSessionSafely(tenantId, sessionId, {
            ownerToken: null,
            mode: 'error',
            code: WINDOW_DRAIN_TIMEOUT,
            actorId,
          });
        } catch (error) {
          this.logger.error(
            `live session ${sessionId} drain-timeout finalization failed ` +
              `(${classifyError(error)}) — row left ERROR-moded for retry`,
          );
        }
        return this.byId(tenantId, sessionId);
      }
      // The loop may have PARKED a retryable finalization — resume it now
      // instead of handing the caller a STOPPING row needing another
      // stop().
      const after = await this.prisma.liveCameraSession.findFirst({
        where: { tenantId, id: sessionId },
      });
      if (after && after.status === LiveCameraSessionStatus.STOPPING) {
        await this.resumeFinalization(tenantId, sessionId, after, actorId);
      }
      return this.byId(tenantId, sessionId);
    }
    // NO LOCAL LOOP (Codex P1 round 3): absence here does NOT mean the
    // session is dead — its loop may live in ANOTHER API process. Only
    // the persisted lease decides.
    const owner = session.leaseOwner ?? null;
    const heartbeatMs = (session.heartbeatAt ?? session.startedAt).getTime();
    const fresh = this.now().getTime() - heartbeatMs < LIVE_SESSION_STALE_MS;
    if (owner !== null && fresh) {
      // FRESH REMOTE OWNER: request the stop and step aside. The remote
      // loop's next heartbeat (RUNNING-conditional) starves, re-reads,
      // recognizes the stop request, drains its in-flight and closed
      // windows, and finalizes the journey ITSELF. Closing the journey
      // here would race evidence that loop can still write — a non-owner
      // never finalizes over a fresh foreign lease (Invariant C).
      await this.prisma.liveCameraSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          status: { in: ACTIVE_SESSION_STATUSES },
          leaseOwner: owner,
        },
        data: { status: LiveCameraSessionStatus.STOPPING },
      });
      return this.byId(tenantId, sessionId);
    }
    if (owner !== null) {
      // STALE remote owner: claim ATOMICALLY — a loop that revived keeps
      // beating and voids this claim. ONE transaction claims the lease
      // AND stamps finalizationMode=ERROR + the STALE_RECLAIMED code AND
      // the durable intent (Codex P1): a reclaimed session with null
      // mode/code could otherwise resume under normal stop semantics and
      // let its abandoned journey reconcile clean. The stamp doubles as
      // the journey-level fence (reconcile reads it before READY).
      // All-or-nothing: a failed intent write rolls the claim back.
      const cutoff = new Date(this.now().getTime() - LIVE_SESSION_STALE_MS);
      let claimed = false;
      try {
        claimed = await this.prisma.$transaction(async (tx) => {
          const res = await tx.liveCameraSession.updateMany({
            where: {
              id: sessionId,
              tenantId,
              status: { in: NON_TERMINAL_SESSION_STATUSES },
              leaseOwner: owner,
              OR: [
                { heartbeatAt: { lt: cutoff } },
                { heartbeatAt: null, startedAt: { lt: cutoff } },
              ],
            },
            data: {
              status: LiveCameraSessionStatus.STOPPING,
              leaseOwner: null,
              finalizationMode: 'ERROR',
              errorCode: STALE_RECLAIMED,
            },
          });
          if (res.count === 0) {
            return false;
          }
          await this.addIntent(tenantId, sessionId, STALE_RECLAIMED_INTENT, tx);
          return true;
        });
      } catch (error) {
        this.logger.warn(
          `live session ${sessionId} stale claim failed ` +
            `(${classifyError(error)}) — nothing claimed, retry later`,
        );
        return this.byId(tenantId, sessionId);
      }
      if (!claimed) {
        // The owner revived (or another claimer won) — downgrade to a
        // stop REQUEST and let the current owner drain.
        await this.prisma.liveCameraSession.updateMany({
          where: {
            id: sessionId,
            tenantId,
            status: { in: ACTIVE_SESSION_STATUSES },
          },
          data: { status: LiveCameraSessionStatus.STOPPING },
        });
        return this.byId(tenantId, sessionId);
      }
    }
    // Parked (lease released) or freshly claimed: resume finalization by
    // the stored code — the finalizer re-reads the row itself, so a
    // journey linked after any earlier snapshot is still closed.
    const current = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (current && current.status !== LiveCameraSessionStatus.STOPPED) {
      await this.resumeFinalization(tenantId, sessionId, current, actorId);
    }
    return this.byId(tenantId, sessionId);
  }

  /** Retry entry: route a parked/claimed row into the finalizer. The
   *  DURABLE finalizationMode column decides exit-vs-abort whenever a
   *  park recorded it — the advisory errorCode is only the legacy
   *  fallback for rows parked without a mode (e.g. stale claims), never
   *  an override (Codex P1: a marker reason must not convert an ERROR
   *  finalization into a clean STOP). */
  private async resumeFinalization(
    tenantId: string,
    sessionId: string,
    row: { errorCode: string | null; finalizationMode?: string | null },
    actorId?: string,
  ): Promise<void> {
    const code = row.errorCode;
    const mode: 'stop' | 'error' =
      row.finalizationMode === 'ERROR'
        ? 'error'
        : row.finalizationMode === 'STOP'
          ? 'stop'
          : code && !STOP_INTENT_CODES.includes(code)
            ? 'error'
            : 'stop';
    try {
      if (mode === 'error') {
        await this.finalizeLiveSessionSafely(tenantId, sessionId, {
          ownerToken: null,
          mode: 'error',
          code,
          actorId,
        });
      } else {
        await this.finalizeLiveSessionSafely(tenantId, sessionId, {
          ownerToken: null,
          mode: 'stop',
          actorId,
        });
      }
    } catch (error) {
      this.logger.error(
        `live session ${sessionId} finalization retry failed ` +
          `(${classifyError(error)}) — row left non-terminal`,
      );
    }
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

  // ------------------------------------------------------------------
  // Phase 14 — live speed pilot testing (observability + dev runner).
  // Read-only over CV state; the safety counts below are COUNT queries
  // only — nothing here writes billing, payment, or inventory rows.
  // ------------------------------------------------------------------

  /**
   * Performance / bottleneck report for one live session: the persisted
   * per-stage timing statistics, the slowest stage, whether fast mode
   * and the VLM were in play, and a zero-mutation safety summary.
   *
   * The safety zeros are STRUCTURAL, not window count queries: this
   * module has no delegate access to order/checkout/payment/inventory
   * tables at all — reads included — and the camera shadow-mode spec
   * fails CI on any reference. (A count-in-window query would also
   * falsely implicate CV for unrelated tenant activity.) Controlled
   * JSON only: no URLs, credentials, or free text.
   */
  async performance(tenantId: string, sessionId: string) {
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: sessionId },
    });
    if (!session) {
      throw new NotFoundException('Live session not found');
    }
    const snapshot =
      session.performance && typeof session.performance === 'object'
        ? (session.performance as unknown as LivePerformanceSnapshot)
        : null;
    const stages = snapshot?.stages ?? {};
    let slowestStage: { stage: string; p95Ms: number; maxMs: number } | null =
      null;
    for (const [stage, stats] of Object.entries(stages)) {
      if (!slowestStage || stats.p95Ms > slowestStage.p95Ms) {
        slowestStage = { stage, p95Ms: stats.p95Ms, maxMs: stats.maxMs };
      }
    }
    return {
      sessionId: session.id,
      status: session.status,
      decision: session.decision,
      // Fast mode is a stamped fact about the SESSION (written at
      // creation). A legacy row without the stamp is UNKNOWN (null) —
      // never inferred from the CURRENT environment, which may have
      // changed since the session ran (Codex P2).
      fastMode: snapshot?.fastMode ?? null,
      vlmInvoked: session.vlmInvoked > 0,
      frameIntervalMs: session.frameIntervalMs,
      framesSampled: session.framesSampled,
      eventWindowsDetected: session.eventWindowsDetected,
      eventWindowsProcessed: session.eventWindowsProcessed,
      reviewNeeded: session.reviewNeeded,
      timings: stages,
      slowestStage,
      safety: {
        orders: 0,
        checkoutSessions: 0,
        paymentIntents: 0,
        paymentEvents: 0,
        inventoryMovements: 0,
        // Why these are zeros by CONSTRUCTION: the camera module cannot
        // address these tables (CI-enforced static guard), so no live
        // session can ever have produced such a row.
        basis: 'SHADOW_MODE_STATIC_GUARD',
      },
    };
  }

  /**
   * Phase 16 — real-footage test PREFLIGHT: one controlled readiness
   * snapshot before a live test run. Read-only; every field is a
   * boolean/enum/controlled string — never a URL, path, credential
   * slot value, or exception text. A missing source reports
   * sourceExists=false instead of throwing (the preflight's job is to
   * SAY what is wrong).
   */
  async liveTestPreflight(
    tenantId: string,
    cameraSourceId: string,
    evaluationRunId?: string | null,
  ) {
    const source = await this.prisma.cameraSource.findFirst({
      where: { tenantId, id: cameraSourceId },
      select: {
        id: true,
        sourceType: true,
        status: true,
        credentialRef: true,
      },
    });
    const sourceExists = source !== null;
    const sourceActive = source?.status === CameraSourceStatus.ACTIVE;
    const sourceTypeSupported =
      source?.sourceType === CameraSourceType.RTSP_SHADOW;
    const sourceConfigured =
      source?.credentialRef != null
        ? this.sampler.resolveSource(tenantId, source.credentialRef).configured
        : false;
    const ffmpegAvailable = await this.sampler.checkFfmpeg();
    const activeSession = await this.prisma.liveCameraSession.findFirst({
      where: {
        tenantId,
        cameraSourceId,
        status: { in: NON_TERMINAL_SESSION_STATUSES },
      },
      select: { id: true },
    });
    let evaluationRunExists: boolean | null = null;
    if (evaluationRunId) {
      const run = await this.prisma.pilotEvaluationRun.findFirst({
        where: { tenantId, id: evaluationRunId },
        select: { id: true },
      });
      evaluationRunExists = run !== null;
    }
    const pilotRunnerEnabled =
      (this.config?.get<string>('CV_LIVE_PILOT_RUNNER_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
    const checks = {
      sourceExists,
      sourceActive,
      sourceTypeSupported,
      sourceConfigured,
      ffmpegAvailable,
      noActiveLiveSession: activeSession === null,
      pilotRunnerEnabled,
    };
    return {
      apiReachable: true,
      cameraSourceId,
      ...checks,
      fastMode: this.liveFastMode(),
      performanceEndpointAvailable: true,
      evaluationRunExists,
      ready: Object.values(checks).every((value) => value === true),
      safety: {
        orders: 0,
        checkoutSessions: 0,
        paymentIntents: 0,
        paymentEvents: 0,
        inventoryMovements: 0,
        basis: 'SHADOW_MODE_STATIC_GUARD',
      },
    };
  }

  /** Phase 14 pilot runner poll cadence (real time). */
  protected pilotPollMs(): number {
    return 1000;
  }

  /**
   * DEV/ADMIN pilot test runner: start a live session against the
   * (file-backed) dev source, wait until enough frames sampled or the
   * time budget elapses, stop it, and return a controlled summary with
   * the performance report. Gated by CV_LIVE_PILOT_RUNNER_ENABLED
   * (default OFF — refuses with a controlled 409). Uses only the
   * EXISTING start/stop lifecycle: every Phase 13 safety property
   * (review-first, credential redaction, tenant isolation, lease
   * ownership) applies unchanged.
   */
  async runPilotTest(
    tenantId: string,
    cameraSourceId: string,
    input: {
      frameIntervalMs?: number | null;
      maxFrames?: number | null;
      maxSeconds?: number | null;
    },
    actorId?: string,
  ) {
    const enabled =
      (this.config?.get<string>('CV_LIVE_PILOT_RUNNER_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
    if (!enabled) {
      throw new ConflictException(
        'pilot test runner is disabled (CV_LIVE_PILOT_RUNNER_ENABLED)',
      );
    }
    // Bounded budgets — a pilot run is a short measurement; the time
    // ceiling matches the 15-minute session auto-stop bound.
    const maxFrames = Math.max(1, Math.min(input.maxFrames ?? 30, 300));
    const maxSeconds = Math.max(
      1,
      Math.min(input.maxSeconds ?? 60, MAX_LIVE_SESSION_MS / 1000),
    );
    // ATOMIC OWNERSHIP (Codex P1): a CREATE-ONLY start — any existing
    // active/non-terminal session on the source (operator's, another
    // pilot's, or a concurrent winner via the one-active-per-source DB
    // unique) is a controlled 409, never adopted. The session returned
    // here therefore exists BECAUSE this call created it, so this pilot
    // may poll and stop it — no timestamp inference anywhere.
    const startedAtMs = Date.now();
    const started = await this.start(
      tenantId,
      cameraSourceId,
      {
        frameIntervalMs: input.frameIntervalMs,
        // Both budgets enforced INSIDE the sampling loop (Codex P2): the
        // loop stops itself at the frame budget or the deadline — the
        // runner's polling cadence can never overshoot either.
        pilotFrameBudget: maxFrames,
        pilotDeadlineAtMs: this.now().getTime() + maxSeconds * 1000,
        requireNewSession: true,
      },
      actorId,
    );
    const sessionId = started.sessionId;
    // From here the session is PILOT-OWNED: whatever happens during
    // polling, the finally below guarantees a stop request — a failed
    // poll must never leave the sampler running to the 15-minute cap
    // (Codex P2).
    let stopped: LiveSessionDetail | null = null;
    try {
      let current = started;
      while (
        current.status === LiveCameraSessionStatus.RUNNING ||
        current.status === LiveCameraSessionStatus.STARTING
      ) {
        if (
          current.framesSampled >= maxFrames ||
          Date.now() - startedAtMs >= maxSeconds * 1000
        ) {
          break;
        }
        await this.sleep(this.pilotPollMs());
        current = await this.byId(tenantId, sessionId);
      }
      stopped = await this.stop(tenantId, sessionId, actorId);
      if (stopped.status === LiveCameraSessionStatus.STOPPING) {
        // One retry for a parked finalization — the pilot summary should
        // reflect a settled session when possible.
        stopped = await this.stop(tenantId, sessionId, actorId);
      }
    } finally {
      if (stopped === null) {
        // The runner failed after start — stop the OWNED session now.
        // Best-effort with a controlled log: the original error is the
        // one that propagates; a cleanup failure leaves the session to
        // the normal stop/stale-reclaim lifecycle.
        await this.stop(tenantId, sessionId, actorId).catch((error) => {
          this.logger.error(
            `pilot session ${sessionId} cleanup stop failed ` +
              `(${classifyError(error)}) — normal stop/reclaim applies`,
          );
        });
      }
    }
    const report = await this.performance(tenantId, sessionId);
    const eventToReview = report.timings['eventToReview'] ?? null;
    return {
      sessionId,
      status: stopped.status,
      decision: stopped.decision,
      errorCode: stopped.errorCode,
      fastMode: report.fastMode,
      elapsedMs: Date.now() - startedAtMs,
      framesSampled: stopped.framesSampled,
      eventWindowsDetected: stopped.eventWindowsDetected,
      eventWindowsProcessed: stopped.eventWindowsProcessed,
      reviewNeeded: stopped.reviewNeeded,
      eventToReviewMs: eventToReview,
      slowestStage: report.slowestStage,
      timings: report.timings,
      safety: report.safety,
    };
  }
}
