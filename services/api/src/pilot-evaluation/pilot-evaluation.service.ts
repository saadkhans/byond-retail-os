import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyEventType,
  PilotEvaluationRunStatus,
  PilotExpectedAction,
  PilotObservationVerdict,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';

/**
 * Phase 15 — live pilot EVALUATION loop (SHADOW ONLY).
 *
 * An evaluation run groups live sessions so pilot accuracy and speed can
 * be measured. Operator reviews are APPEND-ONLY labels over live CV
 * observations (DB trigger enforced): the observation row is never
 * rewritten, no inventory/billing/settlement state is touched anywhere
 * in this module, and the predicted* fields are SERVER-side snapshots of
 * the observation — never caller-supplied. The dataset export emits
 * controlled ids/enums/numbers only: no URLs, file paths, credential
 * slots, raw exception text, or pixels.
 */

/** Bound + screen for operator notes: short free text, rejected (not
 *  silently stripped) when the shared sensitive-text screen trips. */
export const PILOT_NOTES_MAX_LENGTH = 300;

/** Verdicts whose labels are trustworthy TRAINING data: the operator
 *  either CONFIRMED the prediction or supplied the corrected label.
 *  INCORRECT/UNCERTAIN/FALSE_TOUCH/MISSED_EVENT rows stay in metrics but
 *  are NOT exported — they carry no usable positive label. */
export const DATASET_EXPORTABLE_VERDICTS: readonly PilotObservationVerdict[] = [
  PilotObservationVerdict.CORRECT,
  PilotObservationVerdict.WRONG_SKU,
  PilotObservationVerdict.WRONG_ACTION,
];

/** Live crops are never persisted as artifacts in Phase 13/14, so no
 *  safe evidence reference exists to export yet — manifest rows say so
 *  explicitly rather than inventing a storage system. */
export const EVIDENCE_NOT_AVAILABLE = 'NOT_AVAILABLE_IN_PHASE15';

const LIVE_OBSERVATION_EVENT_TYPES: CustomerJourneyEventType[] = [
  CustomerJourneyEventType.PRODUCT_PICKUP,
  CustomerJourneyEventType.PRODUCT_RETURN,
];

function predictedActionOf(
  eventType: CustomerJourneyEventType,
): PilotExpectedAction {
  if (eventType === CustomerJourneyEventType.PRODUCT_PICKUP) {
    return PilotExpectedAction.PICKUP;
  }
  if (eventType === CustomerJourneyEventType.PRODUCT_RETURN) {
    return PilotExpectedAction.RETURN;
  }
  return PilotExpectedAction.UNKNOWN;
}

export interface StageStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface SessionLatency {
  liveSessionId: string;
  eventToReview: StageStats | null;
  fusion: StageStats | null;
  journeyImport: StageStats | null;
  slowestStage: { stage: string; p95Ms: number } | null;
}

@Injectable()
export class PilotEvaluationService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(
    tenantId: string,
    input: { name: string; description?: string | null; locationId?: string | null },
    actorId?: string,
  ) {
    if (input.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { tenantId, id: input.locationId },
        select: { id: true },
      });
      if (!location) {
        throw new NotFoundException('Store not found');
      }
    }
    const run = await this.prisma.pilotEvaluationRun.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description ?? null,
        locationId: input.locationId ?? null,
        createdById: actorId ?? null,
      },
    });
    return this.runDetail(tenantId, run.id);
  }

  async listRuns(tenantId: string) {
    const runs = await this.prisma.pilotEvaluationRun.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: {
        location: { select: { name: true } },
        _count: { select: { sessions: true, reviews: true } },
      },
    });
    return runs.map((run) => ({
      evaluationRunId: run.id,
      name: run.name,
      description: run.description,
      locationId: run.locationId,
      locationName: run.location?.name ?? null,
      status: run.status,
      sessionCount: run._count.sessions,
      reviewCount: run._count.reviews,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
    }));
  }

  private async requireRun(tenantId: string, evaluationRunId: string) {
    const run = await this.prisma.pilotEvaluationRun.findFirst({
      where: { tenantId, id: evaluationRunId },
      include: { location: { select: { name: true } } },
    });
    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
    return run;
  }

  async runDetail(tenantId: string, evaluationRunId: string) {
    const run = await this.requireRun(tenantId, evaluationRunId);
    const sessions = await this.prisma.pilotEvaluationSession.findMany({
      where: { tenantId, evaluationRunId },
      orderBy: [{ createdAt: 'asc' }],
      include: {
        liveSession: {
          select: {
            id: true,
            status: true,
            decision: true,
            startedAt: true,
            stoppedAt: true,
            framesSampled: true,
            eventWindowsDetected: true,
            eventWindowsProcessed: true,
            reviewNeeded: true,
            errorCode: true,
          },
        },
      },
    });
    const reviewCount = await this.prisma.pilotObservationReview.count({
      where: { tenantId, evaluationRunId },
    });
    return {
      evaluationRunId: run.id,
      name: run.name,
      description: run.description,
      locationId: run.locationId,
      locationName: run.location?.name ?? null,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      reviewCount,
      sessions: sessions.map((row) => ({
        liveSessionId: row.liveSessionId,
        attachedAt: row.createdAt,
        status: row.liveSession.status,
        decision: row.liveSession.decision,
        startedAt: row.liveSession.startedAt,
        stoppedAt: row.liveSession.stoppedAt,
        framesSampled: row.liveSession.framesSampled,
        eventWindowsDetected: row.liveSession.eventWindowsDetected,
        eventWindowsProcessed: row.liveSession.eventWindowsProcessed,
        reviewNeeded: row.liveSession.reviewNeeded,
        errorCode: row.liveSession.errorCode,
      })),
    };
  }

  /** OPEN → COMPLETED/CANCELLED only; terminal states are final. */
  async setStatus(
    tenantId: string,
    evaluationRunId: string,
    status: PilotEvaluationRunStatus,
  ) {
    if (status === PilotEvaluationRunStatus.OPEN) {
      throw new BadRequestException('an evaluation run cannot be reopened');
    }
    const updated = await this.prisma.pilotEvaluationRun.updateMany({
      where: {
        id: evaluationRunId,
        tenantId,
        status: PilotEvaluationRunStatus.OPEN,
      },
      data: { status, completedAt: new Date() },
    });
    if (updated.count === 0) {
      const run = await this.requireRun(tenantId, evaluationRunId);
      throw new ConflictException(
        `evaluation run is ${run.status} — only OPEN runs can be closed`,
      );
    }
    return this.runDetail(tenantId, evaluationRunId);
  }

  /** Attach one live session (idempotent — re-attach returns the run). */
  async attachSession(
    tenantId: string,
    evaluationRunId: string,
    liveSessionId: string,
  ) {
    const run = await this.requireRun(tenantId, evaluationRunId);
    if (run.status !== PilotEvaluationRunStatus.OPEN) {
      throw new ConflictException('evaluation run is not OPEN');
    }
    const liveSession = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: liveSessionId },
      select: { id: true },
    });
    if (!liveSession) {
      throw new NotFoundException('Live session not found');
    }
    try {
      await this.prisma.pilotEvaluationSession.create({
        data: { tenantId, evaluationRunId, liveSessionId },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // already attached — idempotent
      } else {
        throw error;
      }
    }
    return this.runDetail(tenantId, evaluationRunId);
  }

  /** The run's attached live sessions with journey link — the review
   *  surface reads observations through these. */
  private async attachedSessions(tenantId: string, evaluationRunId: string) {
    const rows = await this.prisma.pilotEvaluationSession.findMany({
      where: { tenantId, evaluationRunId },
      include: {
        liveSession: { select: { id: true, journeyId: true } },
      },
    });
    return rows.map((row) => ({
      liveSessionId: row.liveSession.id,
      journeyId: row.liveSession.journeyId,
    }));
  }

  /**
   * Live CV observations of the run's attached sessions, each with its
   * LATEST pilot review (older reviews remain as audit history).
   */
  async observations(tenantId: string, evaluationRunId: string) {
    await this.requireRun(tenantId, evaluationRunId);
    const sessions = await this.attachedSessions(tenantId, evaluationRunId);
    const journeyIds = sessions
      .map((row) => row.journeyId)
      .filter((id): id is string => id !== null);
    const journeyToSession = new Map(
      sessions
        .filter((row) => row.journeyId !== null)
        .map((row) => [row.journeyId as string, row.liveSessionId]),
    );
    const reviews = await this.prisma.pilotObservationReview.findMany({
      where: { tenantId, evaluationRunId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // Observations come from two provenances:
    // - LIVE_SHADOW events on journeys of the run's attached sessions.
    // - FUSION_SHADOW events (video bootstrap) that this run's own
    //   reviews reference — video journeys have no live session, so the
    //   review row is the only linkage that can surface them here.
    const reviewedEventIds = [
      ...new Set(
        reviews
          .map((review) => review.journeyEventId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const eventScopes = [
      ...(journeyIds.length
        ? [{ journeyId: { in: journeyIds }, sourceType: 'LIVE_SHADOW' as const }]
        : []),
      ...(reviewedEventIds.length
        ? [
            {
              id: { in: reviewedEventIds },
              sourceType: 'FUSION_SHADOW' as const,
            },
          ]
        : []),
    ];
    const events = eventScopes.length
      ? await this.prisma.customerJourneyEvent.findMany({
          where: {
            tenantId,
            eventType: { in: LIVE_OBSERVATION_EVENT_TYPES },
            OR: eventScopes,
          },
          orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        })
      : [];
    const latestByEvent = new Map<string, (typeof reviews)[number]>();
    const missed: (typeof reviews)[number][] = [];
    for (const review of reviews) {
      if (review.verdict === PilotObservationVerdict.MISSED_EVENT) {
        missed.push(review);
      } else if (review.journeyEventId) {
        latestByEvent.set(review.journeyEventId, review); // ascending → last wins
      }
    }
    return {
      evaluationRunId,
      observations: events.map((event) => {
        const review = latestByEvent.get(event.id) ?? null;
        return {
          journeyEventId: event.id,
          liveSessionId: journeyToSession.get(event.journeyId) ?? null,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          predictedProductId: event.productId,
          predictedSku: event.sku,
          predictedProductName: event.productName,
          matchScore: event.matchScore,
          latestReview: review
            ? {
                reviewId: review.id,
                verdict: review.verdict,
                expectedAction: review.expectedAction,
                expectedProductId: review.expectedProductId,
                expectedSku: review.expectedSku,
                operatorCropArtifactId: review.operatorCropArtifactId,
                notes: review.notes,
                reviewedById: review.reviewedById,
                reviewedAt: review.createdAt,
              }
            : null,
        };
      }),
      missedEvents: missed.map((review) => ({
        reviewId: review.id,
        liveSessionId: review.liveSessionId,
        expectedAction: review.expectedAction,
        expectedProductId: review.expectedProductId,
        expectedSku: review.expectedSku,
        notes: review.notes,
        reviewedAt: review.createdAt,
      })),
    };
  }

  /**
   * APPEND one operator review/correction. Never updates or deletes —
   * a changed mind appends a newer row; metrics use the latest per
   * observation. predicted* snapshots come from the OBSERVATION, never
   * the caller.
   */
  async reviewObservation(
    tenantId: string,
    evaluationRunId: string,
    input: {
      verdict: PilotObservationVerdict;
      expectedAction: PilotExpectedAction;
      journeyEventId?: string | null;
      liveSessionId?: string | null;
      expectedProductId?: string | null;
      notes?: string | null;
      /** One-SKU bootstrap (service-internal — not on the HTTP DTO):
       *  OPAQUE id of the operator-approved manual CROP artifact that
       *  supersedes the automatic crop as this observation's evidence.
       *  Validated below: tenant-scoped, a CROP, operator-created, and
       *  belonging to the SAME video as the reviewed event. */
      operatorCropArtifactId?: string | null;
    },
    actorId?: string,
  ) {
    const run = await this.requireRun(tenantId, evaluationRunId);
    if (run.status !== PilotEvaluationRunStatus.OPEN) {
      throw new ConflictException('evaluation run is not OPEN');
    }
    const notes = (input.notes ?? '').trim();
    if (notes.length > PILOT_NOTES_MAX_LENGTH) {
      throw new BadRequestException(
        `notes must be at most ${PILOT_NOTES_MAX_LENGTH} characters`,
      );
    }
    if (notes && containsSensitiveFreeText(notes)) {
      throw new BadRequestException(
        'notes rejected by the sensitive-content screen',
      );
    }
    // Expected product (the corrected/confirmed label): tenant-scoped,
    // sku snapshotted so the label survives catalog renames.
    let expectedSku: string | null = null;
    if (input.expectedProductId) {
      const product = await this.prisma.product.findFirst({
        where: { tenantId, id: input.expectedProductId },
        select: { sku: true },
      });
      if (!product) {
        throw new NotFoundException('Expected product not found');
      }
      expectedSku = product.sku;
    }
    const sessions = await this.attachedSessions(tenantId, evaluationRunId);

    if (input.verdict === PilotObservationVerdict.MISSED_EVENT) {
      // A missed interaction has no CV event — it is attributed to one
      // attached session instead.
      if (input.journeyEventId) {
        throw new BadRequestException(
          'MISSED_EVENT reviews must not reference a journey event',
        );
      }
      if (input.operatorCropArtifactId) {
        throw new BadRequestException(
          'a missed event has no crop evidence to attach',
        );
      }
      const liveSessionId = input.liveSessionId ?? null;
      if (
        !liveSessionId ||
        !sessions.some((row) => row.liveSessionId === liveSessionId)
      ) {
        throw new BadRequestException(
          'MISSED_EVENT reviews must name a live session attached to this run',
        );
      }
      if (
        input.expectedAction !== PilotExpectedAction.PICKUP &&
        input.expectedAction !== PilotExpectedAction.RETURN
      ) {
        throw new BadRequestException(
          'a missed event needs an expected PICKUP or RETURN',
        );
      }
      const review = await this.prisma.pilotObservationReview.create({
        data: {
          tenantId,
          evaluationRunId,
          liveSessionId,
          verdict: input.verdict,
          expectedAction: input.expectedAction,
          expectedProductId: input.expectedProductId ?? null,
          expectedSku,
          notes: notes || null,
          reviewedById: actorId ?? null,
        },
      });
      return { reviewId: review.id, verdict: review.verdict };
    }

    // Every other verdict labels ONE concrete shadow observation.
    // Two provenances are accepted (tenant-scoped end to end):
    // - LIVE_SHADOW: must belong to a journey of a live session attached
    //   to this run (unchanged Phase 15 rule).
    // - FUSION_SHADOW: a shadow event imported from a CONTROLLED TEST
    //   VIDEO's fusion run (one-SKU bootstrap). No live session exists
    //   for a video clip, so the review row itself is the run linkage
    //   and liveSessionId stays null; the event's videoAssetId is the
    //   evidence locator provenance.
    if (!input.journeyEventId) {
      throw new BadRequestException('journeyEventId is required');
    }
    const event = await this.prisma.customerJourneyEvent.findFirst({
      where: {
        tenantId,
        id: input.journeyEventId,
        sourceType: { in: ['LIVE_SHADOW', 'FUSION_SHADOW'] },
        eventType: { in: LIVE_OBSERVATION_EVENT_TYPES },
      },
    });
    if (!event) {
      throw new NotFoundException('Live observation not found');
    }
    let liveSessionId: string | null = null;
    if (event.sourceType === 'LIVE_SHADOW') {
      const owning = sessions.find((row) => row.journeyId === event.journeyId);
      if (!owning) {
        throw new ConflictException(
          'observation does not belong to a session attached to this run',
        );
      }
      liveSessionId = owning.liveSessionId;
    } else if (!event.videoAssetId) {
      // FUSION_SHADOW without video provenance has no evidence locator
      // an offline trainer could map to footage — refuse to label it.
      throw new BadRequestException(
        'a video-shadow observation needs video provenance',
      );
    }
    // Operator crop evidence (one-SKU bootstrap): STRUCTURED, validated
    // reference — tenant-scoped, a CROP artifact, operator-created, and
    // on the SAME video the reviewed event came from. A cross-tenant or
    // cross-video id can never be attached.
    let operatorCropArtifactId: string | null = null;
    if (input.operatorCropArtifactId) {
      const artifact = await this.prisma.videoArtifact.findFirst({
        where: {
          tenantId,
          id: input.operatorCropArtifactId,
          artifactType: 'CROP',
        },
        select: { id: true, videoAssetId: true, createdById: true },
      });
      if (!artifact) {
        throw new NotFoundException('Crop artifact not found');
      }
      if (artifact.createdById === null) {
        throw new BadRequestException(
          'only an operator-created manual crop can be attached as evidence',
        );
      }
      if (
        event.videoAssetId === null ||
        artifact.videoAssetId !== event.videoAssetId
      ) {
        throw new BadRequestException(
          'the crop artifact does not belong to the reviewed observation’s video',
        );
      }
      operatorCropArtifactId = artifact.id;
    }
    const review = await this.prisma.pilotObservationReview.create({
      data: {
        tenantId,
        evaluationRunId,
        liveSessionId,
        journeyEventId: event.id,
        verdict: input.verdict,
        expectedAction: input.expectedAction,
        expectedProductId: input.expectedProductId ?? null,
        expectedSku,
        // SERVER-side prediction snapshots — never caller-supplied.
        predictedProductId: event.productId,
        predictedSku: event.sku,
        predictedAction: predictedActionOf(event.eventType),
        operatorCropArtifactId,
        notes: notes || null,
        reviewedById: actorId ?? null,
      },
    });
    return { reviewId: review.id, verdict: review.verdict };
  }

  /**
   * Accuracy + confusion + latency + safety summary. Metric definitions
   * (deliberately explicit so they cannot mislead a pilot):
   *  - counts are over the LATEST review per observation (+ every
   *    MISSED_EVENT row);
   *  - action accuracy = (CORRECT + WRONG_SKU) / decided, where decided
   *    excludes UNCERTAIN and MISSED_EVENT (WRONG_SKU means the ACTION
   *    was right); FALSE_TOUCH and WRONG_ACTION and INCORRECT count as
   *    action-wrong;
   *  - SKU accuracy = CORRECT / (CORRECT + WRONG_SKU + INCORRECT) over
   *    observations that carried a predicted product;
   *  - combined accuracy = CORRECT / decided;
   *  - every rate is null when its denominator is 0 — never fabricated.
   */
  async summary(tenantId: string, evaluationRunId: string) {
    const run = await this.requireRun(tenantId, evaluationRunId);
    const { observations, missedEvents } = await this.observations(
      tenantId,
      evaluationRunId,
    );
    const latest = observations
      .map((row) => row.latestReview)
      .filter(
        (review): review is NonNullable<typeof review> => review !== null,
      );
    const count = (verdict: PilotObservationVerdict) =>
      latest.filter((review) => review.verdict === verdict).length;
    const correct = count(PilotObservationVerdict.CORRECT);
    const incorrect = count(PilotObservationVerdict.INCORRECT);
    const uncertain = count(PilotObservationVerdict.UNCERTAIN);
    const falseTouch = count(PilotObservationVerdict.FALSE_TOUCH);
    const wrongSku = count(PilotObservationVerdict.WRONG_SKU);
    const wrongAction = count(PilotObservationVerdict.WRONG_ACTION);
    const missed = missedEvents.length;
    const decided = latest.length - uncertain;
    const rate = (numerator: number, denominator: number) =>
      denominator > 0
        ? Math.round((numerator / denominator) * 1000) / 1000
        : null;

    // Confusion over LABELED observations (predicted vs expected). For
    // CORRECT the expectation IS the prediction.
    const observationByReview = new Map(
      observations
        .filter((row) => row.latestReview !== null)
        .map((row) => [row.latestReview!.reviewId, row]),
    );
    const actionPairs = new Map<string, number>();
    const skuPairs = new Map<string, number>();
    let skuJudged = 0;
    let skuCorrect = 0;
    for (const review of latest) {
      if (review.verdict === PilotObservationVerdict.UNCERTAIN) {
        continue;
      }
      const observation = observationByReview.get(review.reviewId)!;
      const predictedAction = predictedActionOf(observation.eventType);
      const expectedAction =
        review.verdict === PilotObservationVerdict.CORRECT
          ? predictedAction
          : review.expectedAction;
      const actionKey = `${predictedAction}→${expectedAction}`;
      actionPairs.set(actionKey, (actionPairs.get(actionKey) ?? 0) + 1);
      const predictedSku = observation.predictedSku;
      if (predictedSku) {
        if (review.verdict === PilotObservationVerdict.CORRECT) {
          skuJudged += 1;
          skuCorrect += 1;
          const key = `${predictedSku}→${predictedSku}`;
          skuPairs.set(key, (skuPairs.get(key) ?? 0) + 1);
        } else if (
          review.verdict === PilotObservationVerdict.WRONG_SKU ||
          review.verdict === PilotObservationVerdict.INCORRECT
        ) {
          skuJudged += 1;
          const expectedSku = review.expectedSku ?? 'UNKNOWN';
          const key = `${predictedSku}→${expectedSku}`;
          skuPairs.set(key, (skuPairs.get(key) ?? 0) + 1);
        }
      }
    }
    for (const review of missedEvents) {
      const key = `NO_OP→${review.expectedAction}`;
      actionPairs.set(key, (actionPairs.get(key) ?? 0) + 1);
    }
    const toMatrix = (pairs: Map<string, number>) =>
      [...pairs.entries()]
        .map(([key, total]) => {
          const [predicted, expected] = key.split('→');
          return { predicted, expected, count: total };
        })
        .sort((a, b) => b.count - a.count);

    return {
      evaluationRunId,
      status: run.status,
      totals: {
        observations: observations.length,
        reviewed: latest.length,
        unreviewed: observations.length - latest.length,
        correct,
        incorrect,
        uncertain,
        falseTouch,
        wrongSku,
        wrongAction,
        missedEvents: missed,
      },
      accuracy: {
        action: rate(correct + wrongSku, decided),
        sku: rate(skuCorrect, skuJudged),
        combined: rate(correct, decided),
      },
      confusion: {
        action: toMatrix(actionPairs),
        sku: toMatrix(skuPairs),
      },
      latency: await this.latencySummary(tenantId, evaluationRunId),
      safety: {
        orders: 0,
        checkoutSessions: 0,
        paymentIntents: 0,
        paymentEvents: 0,
        inventoryMovements: 0,
        // Structural zeros: this module writes ONLY pilot-evaluation
        // tables (its shadow-mode spec fails CI on any other delegate
        // write) and the camera module's own static guard covers the
        // live runtime.
        basis: 'SHADOW_MODE_STATIC_GUARD',
      },
    };
  }

  /** Per-session Phase 14 timing stats. `combined` is exact when ONE
   *  session is attached, null otherwise (percentiles cannot be merged
   *  honestly from summaries — never fabricated). */
  private async latencySummary(tenantId: string, evaluationRunId: string) {
    const attached = await this.prisma.pilotEvaluationSession.findMany({
      where: { tenantId, evaluationRunId },
      include: { liveSession: { select: { id: true, performance: true } } },
    });
    const sessions: SessionLatency[] = attached.map((row) => {
      const snapshot =
        row.liveSession.performance &&
        typeof row.liveSession.performance === 'object'
          ? (row.liveSession.performance as unknown as {
              stages?: Record<string, StageStats>;
            })
          : null;
      const stages = snapshot?.stages ?? {};
      let slowest: { stage: string; p95Ms: number } | null = null;
      for (const [stage, stats] of Object.entries(stages)) {
        if (!slowest || stats.p95Ms > slowest.p95Ms) {
          slowest = { stage, p95Ms: stats.p95Ms };
        }
      }
      return {
        liveSessionId: row.liveSession.id,
        eventToReview: stages['eventToReview'] ?? null,
        fusion: stages['fusion'] ?? null,
        journeyImport: stages['journeyImport'] ?? null,
        slowestStage: slowest,
      };
    });
    return {
      sessions,
      combined: sessions.length === 1 ? sessions[0] : null,
    };
  }

  /**
   * JSONL dataset manifest: one row per exportable review — the LATEST
   * review per observation, and only verdicts where the operator
   * confirmed or corrected the label (see DATASET_EXPORTABLE_VERDICTS).
   * Controlled ids/enums/numbers only.
   */
  async datasetExport(tenantId: string, evaluationRunId: string) {
    const run = await this.requireRun(tenantId, evaluationRunId);
    const { observations } = await this.observations(
      tenantId,
      evaluationRunId,
    );
    const rows: string[] = [];
    for (const observation of observations) {
      const review = observation.latestReview;
      if (!review || !DATASET_EXPORTABLE_VERDICTS.includes(review.verdict)) {
        continue;
      }
      const predictedAction = predictedActionOf(observation.eventType);
      const isCorrect = review.verdict === PilotObservationVerdict.CORRECT;
      rows.push(
        JSON.stringify({
          tenantId,
          storeId: run.locationId,
          evaluationRunId,
          liveSessionId: observation.liveSessionId,
          journeyEventId: observation.journeyEventId,
          sourceType: 'LIVE_WINDOW',
          // The LABEL: operator-confirmed or operator-corrected.
          expectedAction: isCorrect ? predictedAction : review.expectedAction,
          expectedProductId: isCorrect
            ? observation.predictedProductId
            : review.expectedProductId,
          expectedSku: isCorrect
            ? observation.predictedSku
            : review.expectedSku,
          // The PREDICTION as observed.
          predictedAction,
          predictedProductId: observation.predictedProductId,
          predictedSku: observation.predictedSku,
          confidence: observation.matchScore,
          occurredAt: observation.occurredAt,
          reviewVerdict: review.verdict,
          reviewedAt: review.reviewedAt,
          // No crop/evidence artifact exists for live windows in
          // Phase 13/14 — stated, never faked.
          evidenceStatus: EVIDENCE_NOT_AVAILABLE,
        }),
      );
    }
    return {
      evaluationRunId,
      rowCount: rows.length,
      format: 'jsonl',
      manifest: rows.join('\n'),
    };
  }
}
