import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CvDatasetCandidate,
  CvDatasetCandidateSourceType,
  CvDatasetEligibility,
  CvDatasetImprovementRun,
  CvDatasetImprovementRunStatus,
  CvDatasetPurpose,
  CvDatasetSplit,
  CustomerJourneyEventType,
  PilotExpectedAction,
  PilotObservationVerdict,
  Prisma,
} from '@prisma/client';
import { cvDatasetRunAdvisoryLockKey } from '../common/locks';
import {
  containsCredentialSlotText,
  containsSourceOrPathText,
} from '../common/free-text-safety';
import { PilotEvaluationService } from '../pilot-evaluation/pilot-evaluation.service';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import { SPLIT_BUCKET_SPACE, splitBucket } from './dataset-hash';

/**
 * Phase 18 — dataset improvement & model tuning (SHADOW ONLY, advisory).
 *
 * Turns REVIEWED/CORRECTED Phase 15/16 labels into training-ready
 * METADATA: candidate references, an honest quality report, a
 * deterministic split plan, a safe export manifest for OFFLINE tuning,
 * and an advisory tuning report. Hard rules:
 *  - reviewed/corrected examples only — unreviewed, UNCERTAIN, and
 *    INCONCLUSIVE records are EXCLUDED with a controlled reason;
 *  - references and enum/id snapshots only — never media, paths, URLs,
 *    credential slots, embeddings, or model weights;
 *  - this module writes ONLY its own two tables and never mutates the
 *    review/scenario/source records it reads (static guard enforced);
 *  - missing data is null/zero — never fabricated;
 *  - no training is invoked and no accuracy projection is ever emitted.
 */

export const DATASET_RUN_NAME_MAX_LENGTH = 120;
export const DATASET_RUN_NOTES_MAX_LENGTH = 500;

/** Advisory constant restated on every tuning report. */
export const DATASET_TUNING_ADVISORY =
  'ADVISORY_ONLY_NO_TRAINING_PERFORMED_NO_ACCURACY_GUARANTEE';

/** The export manifest carries record REFERENCES only — stated, never
 *  faked (same honesty rule as Phase 15's evidenceStatus). */
export const DATASET_EVIDENCE_STATUS = 'REFERENCES_ONLY_NO_MEDIA_IN_PHASE18';

/** Fixed, controlled training notes attached to every export manifest. */
export const DATASET_TRAINING_NOTES: readonly string[] = [
  'REVIEWED_AND_CORRECTED_LABELS_ONLY',
  'REFERENCES_ONLY_NO_MEDIA',
  'OFFLINE_TRAINING_ONLY',
  'NO_ACCURACY_GUARANTEE',
];

/** Below this many eligible examples the dataset is flagged SMALL. */
export const SMALL_DATASET_THRESHOLD = 30;

export const DATASET_EXCLUSION_REASONS = [
  'NOT_REVIEWED',
  'UNCERTAIN_VERDICT',
  'INCORRECT_VERDICT',
  'INCONCLUSIVE_RESULT',
  'MISSING_RESULT',
] as const;

export const DATASET_NEXT_ACTIONS = [
  'COLLECT_MORE_EXAMPLES',
  'REVIEW_PENDING_EVENTS',
  'ADD_MISSED_EVENT_LABELS',
  'BALANCE_SKU_COVERAGE',
  'BALANCE_ACTION_COVERAGE',
  'RUN_MORE_PHASE16_PROTOCOLS',
  'IMPROVE_CAMERA_CALIBRATION',
  'EXPORT_DATASET_PACKAGE',
  'HOLD_BACK_TEST_SET',
  'VERIFY_CONFUSION_PAIRS',
] as const;
export type DatasetNextAction = (typeof DATASET_NEXT_ACTIONS)[number];

export type DatasetReadiness = 'READY' | 'WARNING' | 'NOT_READY';

/** Match-score buckets — coarse on purpose: the raw score is an
 *  uncalibrated pipeline value, so only order-of-magnitude bands are
 *  honest to carry into a dataset. */
function confidenceBucketOf(matchScore: number | null): string | null {
  if (matchScore === null || matchScore === undefined) {
    return null;
  }
  if (matchScore >= 0.8) {
    return 'HIGH';
  }
  if (matchScore >= 0.5) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function predictedActionOf(eventType: CustomerJourneyEventType): string {
  if (eventType === CustomerJourneyEventType.PRODUCT_PICKUP) {
    return PilotExpectedAction.PICKUP;
  }
  if (eventType === CustomerJourneyEventType.PRODUCT_RETURN) {
    return PilotExpectedAction.RETURN;
  }
  return PilotExpectedAction.UNKNOWN;
}

/** Verdicts whose rows become ELIGIBLE candidates. Superset of the Phase
 *  15 export list by FALSE_TOUCH: a confirmed false touch is a REVIEWED
 *  corrected NEGATIVE (label NO_OP) — exactly what a false-touch filter
 *  trains on. INCORRECT/UNCERTAIN stay excluded: they carry no usable
 *  label. */
const ELIGIBLE_LIVE_VERDICTS: readonly PilotObservationVerdict[] = [
  PilotObservationVerdict.CORRECT,
  PilotObservationVerdict.WRONG_SKU,
  PilotObservationVerdict.WRONG_ACTION,
  PilotObservationVerdict.FALSE_TOUCH,
];

interface CandidateSeed {
  sourceType: CvDatasetCandidateSourceType;
  sourceId: string;
  liveSessionId: string | null;
  evaluationRunId: string | null;
  protocolId: string | null;
  skuId: string | null;
  skuCodeSnapshot: string | null;
  actionLabel: string;
  correctedActionLabel: string | null;
  reviewVerdict: string;
  reviewSource: string;
  confidenceBucket: string | null;
  scenarioTypeSnapshot: string | null;
  eligibility: CvDatasetEligibility;
  exclusionReason: string | null;
}

export interface DatasetRunView {
  id: string;
  name: string;
  status: CvDatasetImprovementRunStatus;
  purpose: CvDatasetPurpose;
  sourceEvaluationRunId: string | null;
  sourceTestProtocolId: string | null;
  sourceCalibrationProfileId: string | null;
  trainSplitPercent: number;
  validationSplitPercent: number;
  testSplitPercent: number;
  minReviewedExamplesPerSku: number;
  minReviewedExamplesPerAction: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  exportedAt: Date | null;
  archivedAt: Date | null;
}

export interface DatasetCandidateView {
  id: string;
  sourceType: CvDatasetCandidateSourceType;
  sourceId: string;
  liveSessionId: string | null;
  evaluationRunId: string | null;
  protocolId: string | null;
  calibrationProfileId: string | null;
  skuId: string | null;
  skuCodeSnapshot: string | null;
  actionLabel: string;
  correctedActionLabel: string | null;
  reviewVerdict: string;
  reviewSource: string;
  confidenceBucket: string | null;
  lightingBucket: string | null;
  occlusionBucket: string | null;
  calibrationZoneLabel: string | null;
  scenarioTypeSnapshot: string | null;
  split: CvDatasetSplit | null;
  eligibility: CvDatasetEligibility;
  exclusionReason: string | null;
  createdAt: Date;
}

function toRunView(run: CvDatasetImprovementRun): DatasetRunView {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    purpose: run.purpose,
    sourceEvaluationRunId: run.sourceEvaluationRunId,
    sourceTestProtocolId: run.sourceTestProtocolId,
    sourceCalibrationProfileId: run.sourceCalibrationProfileId,
    trainSplitPercent: run.trainSplitPercent,
    validationSplitPercent: run.validationSplitPercent,
    testSplitPercent: run.testSplitPercent,
    minReviewedExamplesPerSku: run.minReviewedExamplesPerSku,
    minReviewedExamplesPerAction: run.minReviewedExamplesPerAction,
    notes: run.notes,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exportedAt: run.exportedAt,
    archivedAt: run.archivedAt,
  };
}

function toCandidateView(row: CvDatasetCandidate): DatasetCandidateView {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    liveSessionId: row.liveSessionId,
    evaluationRunId: row.evaluationRunId,
    protocolId: row.protocolId,
    calibrationProfileId: row.calibrationProfileId,
    skuId: row.skuId,
    skuCodeSnapshot: row.skuCodeSnapshot,
    actionLabel: row.actionLabel,
    correctedActionLabel: row.correctedActionLabel,
    reviewVerdict: row.reviewVerdict,
    reviewSource: row.reviewSource,
    confidenceBucket: row.confidenceBucket,
    lightingBucket: row.lightingBucket,
    occlusionBucket: row.occlusionBucket,
    calibrationZoneLabel: row.calibrationZoneLabel,
    scenarioTypeSnapshot: row.scenarioTypeSnapshot,
    split: row.split,
    eligibility: row.eligibility,
    exclusionReason: row.exclusionReason,
    createdAt: row.createdAt,
  };
}

/** The effective LABEL of a candidate — the corrected action when the
 *  reviewer overrode the prediction, the (confirmed) prediction
 *  otherwise. */
function effectiveAction(row: {
  actionLabel: string;
  correctedActionLabel: string | null;
}): string {
  return row.correctedActionLabel ?? row.actionLabel;
}

const SAFETY = {
  orders: 0,
  checkoutSessions: 0,
  paymentIntents: 0,
  paymentEvents: 0,
  inventoryMovements: 0,
  // Structural zeros: this module writes ONLY its own two dataset
  // tables (its shadow-mode spec fails CI on any other delegate write).
  basis: 'SHADOW_MODE_STATIC_GUARD',
} as const;

@Injectable()
export class CvDatasetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluations: PilotEvaluationService,
  ) {}

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  /** Same 4-step screen as Phase 17 calibration text: length cap, the
   *  sensitive-content predicate, the no-URL/no-path predicate, and the
   *  credential-slot namespace predicate. The submitted value is NEVER
   *  echoed in the error. */
  private screenText(
    label: string,
    value: string | null | undefined,
    maxLength: number,
  ): string | null {
    const text = (value ?? '').trim();
    if (!text) {
      return null;
    }
    if (text.length > maxLength) {
      throw new BadRequestException(
        `${label} must be at most ${maxLength} characters`,
      );
    }
    if (containsSensitiveFreeText(text)) {
      throw new BadRequestException(
        `${label} rejected by the sensitive-content screen`,
      );
    }
    if (containsSourceOrPathText(text)) {
      throw new BadRequestException(
        `${label} rejected: URLs and file paths are not allowed in dataset text`,
      );
    }
    if (containsCredentialSlotText(text)) {
      throw new BadRequestException(
        `${label} must not reference credential or source slot names`,
      );
    }
    return text;
  }

  private async requireRun(tenantId: string, runId: string) {
    const run = await this.prisma.cvDatasetImprovementRun.findFirst({
      where: { tenantId, id: runId },
    });
    if (!run) {
      throw new NotFoundException('Dataset improvement run not found');
    }
    return run;
  }

  /** Serializes refresh / plan / export / status per run. */
  private async withRunLock<T>(
    tenantId: string,
    runId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // ::text cast is load-bearing (see common/locks.ts).
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${cvDatasetRunAdvisoryLockKey(tenantId, runId)}))::text`;
      return work(tx);
    });
  }

  /** Tenant-scoped validation of the three optional source links. */
  private async validateSourceLinks(
    tenantId: string,
    links: {
      sourceEvaluationRunId?: string | null;
      sourceTestProtocolId?: string | null;
      sourceCalibrationProfileId?: string | null;
    },
  ) {
    if (links.sourceEvaluationRunId) {
      const run = await this.prisma.pilotEvaluationRun.findFirst({
        where: { tenantId, id: links.sourceEvaluationRunId },
        select: { id: true },
      });
      if (!run) {
        throw new NotFoundException('Evaluation run not found');
      }
    }
    if (links.sourceTestProtocolId) {
      const protocol = await this.prisma.cvTestProtocol.findFirst({
        where: { tenantId, id: links.sourceTestProtocolId },
        select: { id: true },
      });
      if (!protocol) {
        throw new NotFoundException('Test protocol not found');
      }
    }
    if (links.sourceCalibrationProfileId) {
      const profile = await this.prisma.cameraCalibrationProfile.findFirst({
        where: { tenantId, id: links.sourceCalibrationProfileId },
        select: { id: true },
      });
      if (!profile) {
        throw new NotFoundException('Calibration profile not found');
      }
    }
  }

  private validatePercents(input: {
    trainSplitPercent: number;
    validationSplitPercent: number;
    testSplitPercent: number;
  }) {
    const sum =
      input.trainSplitPercent +
      input.validationSplitPercent +
      input.testSplitPercent;
    if (sum !== 100) {
      throw new BadRequestException(
        'trainSplitPercent + validationSplitPercent + testSplitPercent must sum to exactly 100',
      );
    }
  }

  // ------------------------------------------------------------------
  // run CRUD
  // ------------------------------------------------------------------

  async createRun(
    tenantId: string,
    input: {
      name: string;
      purpose: CvDatasetPurpose;
      sourceEvaluationRunId?: string | null;
      sourceTestProtocolId?: string | null;
      sourceCalibrationProfileId?: string | null;
      trainSplitPercent: number;
      validationSplitPercent: number;
      testSplitPercent: number;
      minReviewedExamplesPerSku?: number | null;
      minReviewedExamplesPerAction?: number | null;
      notes?: string | null;
    },
    actorId?: string,
  ) {
    const name = this.screenText('name', input.name, DATASET_RUN_NAME_MAX_LENGTH);
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const notes = this.screenText(
      'notes',
      input.notes,
      DATASET_RUN_NOTES_MAX_LENGTH,
    );
    this.validatePercents(input);
    await this.validateSourceLinks(tenantId, input);
    const run = await this.prisma.cvDatasetImprovementRun.create({
      data: {
        tenantId,
        name,
        purpose: input.purpose,
        sourceEvaluationRunId: input.sourceEvaluationRunId ?? null,
        sourceTestProtocolId: input.sourceTestProtocolId ?? null,
        sourceCalibrationProfileId: input.sourceCalibrationProfileId ?? null,
        trainSplitPercent: input.trainSplitPercent,
        validationSplitPercent: input.validationSplitPercent,
        testSplitPercent: input.testSplitPercent,
        minReviewedExamplesPerSku: input.minReviewedExamplesPerSku ?? 5,
        minReviewedExamplesPerAction: input.minReviewedExamplesPerAction ?? 5,
        notes,
        createdById: actorId ?? null,
      },
    });
    return toRunView(run);
  }

  async listRuns(tenantId: string) {
    const runs = await this.prisma.cvDatasetImprovementRun.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return runs.map(toRunView);
  }

  async runDetail(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    const candidates = await this.prisma.cvDatasetCandidate.findMany({
      where: { tenantId, runId },
      select: { eligibility: true, split: true },
    });
    const eligible = candidates.filter(
      (row) => row.eligibility === CvDatasetEligibility.ELIGIBLE,
    );
    const bySplit = {
      TRAIN: 0,
      VALIDATION: 0,
      TEST: 0,
      HOLDOUT: 0,
      UNPLANNED: 0,
    };
    for (const row of eligible) {
      if (row.split) {
        bySplit[row.split] += 1;
      } else {
        bySplit.UNPLANNED += 1;
      }
    }
    return {
      ...toRunView(run),
      candidateSummary: {
        total: candidates.length,
        eligible: eligible.length,
        excluded: candidates.length - eligible.length,
        bySplit,
      },
    };
  }

  async updateRun(
    tenantId: string,
    runId: string,
    input: {
      name?: string | null;
      purpose?: CvDatasetPurpose | null;
      sourceEvaluationRunId?: string | null;
      sourceTestProtocolId?: string | null;
      sourceCalibrationProfileId?: string | null;
      trainSplitPercent?: number | null;
      validationSplitPercent?: number | null;
      testSplitPercent?: number | null;
      minReviewedExamplesPerSku?: number | null;
      minReviewedExamplesPerAction?: number | null;
      notes?: string | null;
    },
  ) {
    const run = await this.requireRun(tenantId, runId);
    if (run.status !== CvDatasetImprovementRunStatus.DRAFT) {
      throw new BadRequestException('only DRAFT runs can be edited');
    }
    const data: Prisma.CvDatasetImprovementRunUncheckedUpdateManyInput = {};
    if (input.name !== undefined) {
      const name = this.screenText('name', input.name, DATASET_RUN_NAME_MAX_LENGTH);
      if (!name) {
        throw new BadRequestException('name is required');
      }
      data.name = name;
    }
    if (input.purpose !== undefined && input.purpose !== null) {
      data.purpose = input.purpose;
    }
    if (input.notes !== undefined) {
      data.notes = this.screenText(
        'notes',
        input.notes,
        DATASET_RUN_NOTES_MAX_LENGTH,
      );
    }
    const percents = {
      trainSplitPercent: input.trainSplitPercent ?? run.trainSplitPercent,
      validationSplitPercent:
        input.validationSplitPercent ?? run.validationSplitPercent,
      testSplitPercent: input.testSplitPercent ?? run.testSplitPercent,
    };
    this.validatePercents(percents);
    data.trainSplitPercent = percents.trainSplitPercent;
    data.validationSplitPercent = percents.validationSplitPercent;
    data.testSplitPercent = percents.testSplitPercent;
    if (input.minReviewedExamplesPerSku != null) {
      data.minReviewedExamplesPerSku = input.minReviewedExamplesPerSku;
    }
    if (input.minReviewedExamplesPerAction != null) {
      data.minReviewedExamplesPerAction = input.minReviewedExamplesPerAction;
    }
    const links = {
      sourceEvaluationRunId:
        input.sourceEvaluationRunId !== undefined
          ? input.sourceEvaluationRunId
          : run.sourceEvaluationRunId,
      sourceTestProtocolId:
        input.sourceTestProtocolId !== undefined
          ? input.sourceTestProtocolId
          : run.sourceTestProtocolId,
      sourceCalibrationProfileId:
        input.sourceCalibrationProfileId !== undefined
          ? input.sourceCalibrationProfileId
          : run.sourceCalibrationProfileId,
    };
    await this.validateSourceLinks(tenantId, links);
    data.sourceEvaluationRunId = links.sourceEvaluationRunId;
    data.sourceTestProtocolId = links.sourceTestProtocolId;
    data.sourceCalibrationProfileId = links.sourceCalibrationProfileId;
    await this.prisma.cvDatasetImprovementRun.updateMany({
      where: { tenantId, id: runId },
      data,
    });
    return this.runDetail(tenantId, runId);
  }

  /** DRAFT → READY (gated on the honest quality readiness) and
   *  anything-but-ARCHIVED → ARCHIVED. EXPORTED is stamped only by the
   *  export endpoint. */
  async setStatus(
    tenantId: string,
    runId: string,
    status: CvDatasetImprovementRunStatus,
  ) {
    const run = await this.requireRun(tenantId, runId);
    if (status === CvDatasetImprovementRunStatus.ARCHIVED) {
      if (run.status === CvDatasetImprovementRunStatus.ARCHIVED) {
        throw new BadRequestException('run is already ARCHIVED');
      }
      await this.withRunLock(tenantId, runId, (tx) =>
        tx.cvDatasetImprovementRun.updateMany({
          where: { tenantId, id: runId },
          data: {
            status: CvDatasetImprovementRunStatus.ARCHIVED,
            archivedAt: new Date(),
          },
        }),
      );
      return this.runDetail(tenantId, runId);
    }
    if (status === CvDatasetImprovementRunStatus.READY) {
      if (run.status !== CvDatasetImprovementRunStatus.DRAFT) {
        throw new BadRequestException('only DRAFT runs can become READY');
      }
      const internals = await this.qualityInternals(tenantId, run);
      if (internals.readiness === 'NOT_READY') {
        throw new BadRequestException(
          'run is not ready: minimum reviewed data is missing',
        );
      }
      await this.withRunLock(tenantId, runId, (tx) =>
        tx.cvDatasetImprovementRun.updateMany({
          where: { tenantId, id: runId },
          data: { status: CvDatasetImprovementRunStatus.READY },
        }),
      );
      return this.runDetail(tenantId, runId);
    }
    throw new BadRequestException('status must be READY or ARCHIVED');
  }

  // ------------------------------------------------------------------
  // candidate collection (reviewed/corrected only)
  // ------------------------------------------------------------------

  /** Rebuilds the candidate ledger from the linked sources. Candidates
   *  are REFERENCES + safe snapshots; the source records are never
   *  mutated. lightingBucket/occlusionBucket/calibrationZoneLabel stay
   *  null in the MVP — no source data exists for them, and Phase 18
   *  never fabricates values. DATASET_EXPORT_ITEM is reserved and never
   *  emitted here. */
  private async collectCandidates(
    tenantId: string,
    run: CvDatasetImprovementRun,
  ): Promise<CandidateSeed[]> {
    const seeds: CandidateSeed[] = [];
    if (run.sourceEvaluationRunId) {
      const { observations, missedEvents } = await this.evaluations.observations(
        tenantId,
        run.sourceEvaluationRunId,
      );
      for (const observation of observations) {
        const predictedAction = predictedActionOf(observation.eventType);
        const review = observation.latestReview;
        const base = {
          sourceType: CvDatasetCandidateSourceType.LIVE_REVIEW,
          sourceId: observation.journeyEventId,
          liveSessionId: observation.liveSessionId,
          evaluationRunId: run.sourceEvaluationRunId,
          protocolId: null,
          actionLabel: predictedAction,
          reviewSource: 'PILOT_EVALUATION',
          confidenceBucket: confidenceBucketOf(observation.matchScore),
          scenarioTypeSnapshot: null,
        };
        if (!review) {
          seeds.push({
            ...base,
            skuId: observation.predictedProductId,
            skuCodeSnapshot: observation.predictedSku,
            correctedActionLabel: null,
            reviewVerdict: 'UNREVIEWED',
            eligibility: CvDatasetEligibility.EXCLUDED,
            exclusionReason: 'NOT_REVIEWED',
          });
          continue;
        }
        if (ELIGIBLE_LIVE_VERDICTS.includes(review.verdict)) {
          const isCorrect = review.verdict === PilotObservationVerdict.CORRECT;
          const isFalseTouch =
            review.verdict === PilotObservationVerdict.FALSE_TOUCH;
          seeds.push({
            ...base,
            // The LABEL: operator-confirmed (CORRECT → the prediction) or
            // operator-corrected (everything else → the review's truth).
            skuId: isCorrect
              ? observation.predictedProductId
              : review.expectedProductId,
            skuCodeSnapshot: isCorrect
              ? observation.predictedSku
              : review.expectedSku,
            correctedActionLabel: isFalseTouch
              ? PilotExpectedAction.NO_OP
              : review.verdict === PilotObservationVerdict.WRONG_ACTION
                ? review.expectedAction
                : null,
            reviewVerdict: review.verdict,
            eligibility: CvDatasetEligibility.ELIGIBLE,
            exclusionReason: null,
          });
          continue;
        }
        seeds.push({
          ...base,
          skuId: observation.predictedProductId,
          skuCodeSnapshot: observation.predictedSku,
          correctedActionLabel: null,
          reviewVerdict: review.verdict,
          eligibility: CvDatasetEligibility.EXCLUDED,
          exclusionReason:
            review.verdict === PilotObservationVerdict.UNCERTAIN
              ? 'UNCERTAIN_VERDICT'
              : 'INCORRECT_VERDICT',
        });
      }
      for (const missed of missedEvents) {
        // A missed event is a reviewed ground-truth interaction the CV
        // never produced — recall evidence, referenced by its review id.
        seeds.push({
          sourceType: CvDatasetCandidateSourceType.MISSED_EVENT,
          sourceId: missed.reviewId,
          liveSessionId: missed.liveSessionId,
          evaluationRunId: run.sourceEvaluationRunId,
          protocolId: null,
          skuId: missed.expectedProductId,
          skuCodeSnapshot: missed.expectedSku,
          actionLabel: missed.expectedAction,
          correctedActionLabel: null,
          reviewVerdict: PilotObservationVerdict.MISSED_EVENT,
          reviewSource: 'PILOT_EVALUATION',
          confidenceBucket: null,
          scenarioTypeSnapshot: null,
          eligibility: CvDatasetEligibility.ELIGIBLE,
          exclusionReason: null,
        });
      }
    }
    if (run.sourceTestProtocolId) {
      const protocol = await this.prisma.cvTestProtocol.findFirst({
        where: { tenantId, id: run.sourceTestProtocolId },
        select: { id: true },
      });
      if (!protocol) {
        throw new NotFoundException('Test protocol not found');
      }
      const scenarios = await this.prisma.cvTestProtocolScenario.findMany({
        where: { tenantId, protocolId: run.sourceTestProtocolId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const scenario of scenarios) {
        const decided =
          scenario.result === 'PASS' || scenario.result === 'FAIL';
        seeds.push({
          sourceType: CvDatasetCandidateSourceType.PROTOCOL_SCENARIO,
          sourceId: scenario.id,
          liveSessionId: scenario.liveSessionId,
          evaluationRunId: run.sourceEvaluationRunId,
          protocolId: run.sourceTestProtocolId,
          skuId: scenario.expectedProductId,
          skuCodeSnapshot: scenario.expectedSku,
          actionLabel: scenario.expectedAction,
          correctedActionLabel: null,
          reviewVerdict: scenario.result ?? 'PENDING',
          reviewSource: 'CV_TEST_PROTOCOL',
          confidenceBucket: null,
          scenarioTypeSnapshot: scenario.scenarioType,
          eligibility: decided
            ? CvDatasetEligibility.ELIGIBLE
            : CvDatasetEligibility.EXCLUDED,
          exclusionReason: decided
            ? null
            : scenario.result === 'INCONCLUSIVE'
              ? 'INCONCLUSIVE_RESULT'
              : 'MISSING_RESULT',
        });
      }
    }
    return seeds;
  }

  /** Delete + rebuild the candidate ledger (never touches the source
   *  records). Zero linked sources → zero rows, reported plainly. */
  async refreshCandidates(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    if (
      run.status === CvDatasetImprovementRunStatus.ARCHIVED ||
      run.status === CvDatasetImprovementRunStatus.EXPORTED
    ) {
      throw new BadRequestException(
        `candidates cannot be refreshed on a ${run.status} run`,
      );
    }
    const seeds = await this.collectCandidates(tenantId, run);
    await this.withRunLock(tenantId, runId, async (tx) => {
      await tx.cvDatasetCandidate.deleteMany({ where: { tenantId, runId } });
      if (seeds.length) {
        await tx.cvDatasetCandidate.createMany({
          data: seeds.map((seed) => ({
            tenantId,
            runId,
            calibrationProfileId: run.sourceCalibrationProfileId,
            lightingBucket: null,
            occlusionBucket: null,
            calibrationZoneLabel: null,
            split: null,
            ...seed,
          })),
        });
      }
    });
    const eligible = seeds.filter(
      (seed) => seed.eligibility === CvDatasetEligibility.ELIGIBLE,
    ).length;
    return {
      runId,
      total: seeds.length,
      eligible,
      excluded: seeds.length - eligible,
    };
  }

  async listCandidates(
    tenantId: string,
    runId: string,
    eligibility?: CvDatasetEligibility,
  ) {
    await this.requireRun(tenantId, runId);
    const rows = await this.prisma.cvDatasetCandidate.findMany({
      where: {
        tenantId,
        runId,
        ...(eligibility ? { eligibility } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return { total: rows.length, items: rows.map(toCandidateView) };
  }

  // ------------------------------------------------------------------
  // quality report
  // ------------------------------------------------------------------

  private async qualityInternals(
    tenantId: string,
    run: CvDatasetImprovementRun,
  ) {
    const candidates = await this.prisma.cvDatasetCandidate.findMany({
      where: { tenantId, runId: run.id },
    });
    const eligible = candidates.filter(
      (row) => row.eligibility === CvDatasetEligibility.ELIGIBLE,
    );
    const excluded = candidates.filter(
      (row) => row.eligibility === CvDatasetEligibility.EXCLUDED,
    );
    const countBy = (values: (string | null)[]) => {
      const counts = new Map<string, number>();
      for (const value of values) {
        if (value === null) {
          continue;
        }
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return counts;
    };
    const toSorted = <K extends string>(counts: Map<string, number>, key: K) =>
      [...counts.entries()]
        .map(([value, count]) => ({ [key]: value, count }) as Record<
          K | 'count',
          string | number
        >)
        .sort((a, b) => (b.count as number) - (a.count as number));

    const skuCounts = countBy(eligible.map((row) => row.skuCodeSnapshot));
    const actionCounts = countBy(eligible.map((row) => effectiveAction(row)));
    const scenarioCounts = countBy(
      eligible.map((row) => row.scenarioTypeSnapshot),
    );
    const sourceTypeCounts = countBy(eligible.map((row) => row.sourceType));
    const profileCounts = countBy(
      eligible.map((row) => row.calibrationProfileId),
    );
    const missedEventCount = eligible.filter(
      (row) => row.sourceType === CvDatasetCandidateSourceType.MISSED_EVENT,
    ).length;
    const falseTouchCount = eligible.filter(
      (row) => row.reviewVerdict === PilotObservationVerdict.FALSE_TOUCH,
    ).length;

    // Confusion pairs come verbatim from the Phase 15 summary — never
    // recomputed here, null when no evaluation run is linked (or the
    // linked run has since vanished).
    let confusionPairs: {
      action: { predicted: string; expected: string; count: number }[];
      sku: { predicted: string; expected: string; count: number }[];
    } | null = null;
    if (run.sourceEvaluationRunId) {
      try {
        const summary = await this.evaluations.summary(
          tenantId,
          run.sourceEvaluationRunId,
        );
        confusionPairs = summary.confusion;
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }
    }

    const lowCoverageSkus = [...skuCounts.entries()]
      .filter(([, count]) => count < run.minReviewedExamplesPerSku)
      .map(([sku, count]) => ({
        sku,
        count,
        minimum: run.minReviewedExamplesPerSku,
      }))
      .sort((a, b) => a.count - b.count);
    const lowCoverageActions = [...actionCounts.entries()]
      .filter(([, count]) => count < run.minReviewedExamplesPerAction)
      .map(([action, count]) => ({
        action,
        count,
        minimum: run.minReviewedExamplesPerAction,
      }))
      .sort((a, b) => a.count - b.count);

    const imbalanceWarnings: string[] = [];
    const skuLabeled = [...skuCounts.values()].reduce((a, b) => a + b, 0);
    const topSku = Math.max(0, ...skuCounts.values());
    if (skuCounts.size > 1 && topSku > skuLabeled * 0.5) {
      imbalanceWarnings.push('SKU_IMBALANCE');
    }
    const actionLabeled = [...actionCounts.values()].reduce((a, b) => a + b, 0);
    const topAction = Math.max(0, ...actionCounts.values());
    if (actionCounts.size > 1 && topAction > actionLabeled * 0.5) {
      imbalanceWarnings.push('ACTION_IMBALANCE');
    }

    const leakageWarnings: string[] = [];
    const splitsPlanned =
      eligible.length > 0 && eligible.every((row) => row.split !== null);
    if (eligible.length > 0 && !splitsPlanned) {
      leakageWarnings.push('SPLITS_NOT_PLANNED');
    }
    const splitBySession = new Map<string, Set<string>>();
    for (const row of eligible) {
      if (row.liveSessionId && row.split) {
        const set = splitBySession.get(row.liveSessionId) ?? new Set<string>();
        set.add(row.split);
        splitBySession.set(row.liveSessionId, set);
      }
    }
    if ([...splitBySession.values()].some((set) => set.size > 1)) {
      leakageWarnings.push('SAME_SESSION_ACROSS_SPLITS');
    }

    const readiness: DatasetReadiness =
      eligible.length === 0
        ? 'NOT_READY'
        : lowCoverageSkus.length ||
            lowCoverageActions.length ||
            imbalanceWarnings.length ||
            leakageWarnings.length
          ? 'WARNING'
          : 'READY';

    const notReviewedCount = excluded.filter(
      (row) => row.exclusionReason === 'NOT_REVIEWED',
    ).length;
    const eligibleProtocol = eligible.some(
      (row) =>
        row.sourceType === CvDatasetCandidateSourceType.PROTOCOL_SCENARIO,
    );
    const recommendedNextActions: DatasetNextAction[] = [];
    if (eligible.length < SMALL_DATASET_THRESHOLD) {
      recommendedNextActions.push('COLLECT_MORE_EXAMPLES');
    }
    if (notReviewedCount > 0) {
      recommendedNextActions.push('REVIEW_PENDING_EVENTS');
    }
    if (missedEventCount === 0 && eligible.length > 0) {
      recommendedNextActions.push('ADD_MISSED_EVENT_LABELS');
    }
    if (lowCoverageSkus.length || imbalanceWarnings.includes('SKU_IMBALANCE')) {
      recommendedNextActions.push('BALANCE_SKU_COVERAGE');
    }
    if (
      lowCoverageActions.length ||
      imbalanceWarnings.includes('ACTION_IMBALANCE')
    ) {
      recommendedNextActions.push('BALANCE_ACTION_COVERAGE');
    }
    if (!run.sourceTestProtocolId || !eligibleProtocol) {
      recommendedNextActions.push('RUN_MORE_PHASE16_PROTOCOLS');
    }
    if (!run.sourceCalibrationProfileId) {
      recommendedNextActions.push('IMPROVE_CAMERA_CALIBRATION');
    }
    if (readiness === 'READY' && splitsPlanned) {
      recommendedNextActions.push('EXPORT_DATASET_PACKAGE');
    }
    if (leakageWarnings.includes('SPLITS_NOT_PLANNED')) {
      recommendedNextActions.push('HOLD_BACK_TEST_SET');
    }
    if (
      confusionPairs &&
      [...confusionPairs.action, ...confusionPairs.sku].some(
        (pair) => pair.count > 1,
      )
    ) {
      recommendedNextActions.push('VERIFY_CONFUSION_PAIRS');
    }

    return {
      candidates,
      eligible,
      excluded,
      skuCounts,
      actionCounts,
      scenarioCounts,
      sourceTypeCounts,
      profileCounts,
      missedEventCount,
      falseTouchCount,
      confusionPairs,
      lowCoverageSkus,
      lowCoverageActions,
      imbalanceWarnings,
      leakageWarnings,
      splitsPlanned,
      readiness,
      recommendedNextActions,
      toSorted,
    };
  }

  async qualityReport(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    const internals = await this.qualityInternals(tenantId, run);
    return {
      runId,
      totalEligibleExamples: internals.eligible.length,
      totalExcludedExamples: internals.excluded.length,
      examplesBySku: internals.toSorted(internals.skuCounts, 'sku'),
      examplesByAction: internals.toSorted(internals.actionCounts, 'action'),
      examplesByScenarioType: internals.toSorted(
        internals.scenarioCounts,
        'scenarioType',
      ),
      examplesBySourceType: internals.toSorted(
        internals.sourceTypeCounts,
        'sourceType',
      ),
      examplesByCalibrationProfile: internals.toSorted(
        internals.profileCounts,
        'calibrationProfileId',
      ),
      missedEventCount: internals.missedEventCount,
      falseTouchCount: internals.falseTouchCount,
      confusionPairs: internals.confusionPairs,
      lowCoverageSkus: internals.lowCoverageSkus,
      lowCoverageActions: internals.lowCoverageActions,
      imbalanceWarnings: internals.imbalanceWarnings,
      leakageWarnings: internals.leakageWarnings,
      readiness: internals.readiness,
      recommendedNextActions: internals.recommendedNextActions,
      safety: SAFETY,
    };
  }

  // ------------------------------------------------------------------
  // split planner (deterministic)
  // ------------------------------------------------------------------

  /** Deterministic split assignment: examples from the SAME live session
   *  share a hash group (leakage guard), the group's sha256 bucket picks
   *  the split against the run's percentages, and low-coverage classes
   *  are forced WHOLE-GROUP into TRAIN with a warning rather than
   *  pretending a 2-example test set means anything. HOLDOUT is never
   *  auto-assigned in the MVP. Only this run's candidate rows are
   *  updated — review/scenario/source records are never mutated. */
  async planSplits(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    if (
      run.status !== CvDatasetImprovementRunStatus.DRAFT &&
      run.status !== CvDatasetImprovementRunStatus.READY
    ) {
      throw new BadRequestException(
        `splits cannot be planned on a ${run.status} run`,
      );
    }
    const candidates = await this.prisma.cvDatasetCandidate.findMany({
      where: { tenantId, runId },
    });
    const eligible = candidates.filter(
      (row) => row.eligibility === CvDatasetEligibility.ELIGIBLE,
    );
    if (eligible.length === 0) {
      throw new BadRequestException(
        'no eligible candidates — refresh candidates first',
      );
    }

    const skuCounts = new Map<string, number>();
    const actionCounts = new Map<string, number>();
    for (const row of eligible) {
      if (row.skuCodeSnapshot) {
        skuCounts.set(
          row.skuCodeSnapshot,
          (skuCounts.get(row.skuCodeSnapshot) ?? 0) + 1,
        );
      }
      const action = effectiveAction(row);
      actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    }
    const lowSkus = new Set(
      [...skuCounts.entries()]
        .filter(([, count]) => count < run.minReviewedExamplesPerSku)
        .map(([sku]) => sku),
    );
    const lowActions = new Set(
      [...actionCounts.entries()]
        .filter(([, count]) => count < run.minReviewedExamplesPerAction)
        .map(([action]) => action),
    );

    // Same live session → same group → same split (leakage guard).
    const groups = new Map<string, CvDatasetCandidate[]>();
    for (const row of eligible) {
      const groupKey = row.liveSessionId ?? `solo:${row.sourceId}`;
      const rows = groups.get(groupKey) ?? [];
      rows.push(row);
      groups.set(groupKey, rows);
    }

    const trainCeiling = run.trainSplitPercent * (SPLIT_BUCKET_SPACE / 100);
    const validationCeiling =
      (run.trainSplitPercent + run.validationSplitPercent) *
      (SPLIT_BUCKET_SPACE / 100);
    const warnings = new Set<string>();
    const assignment = new Map<CvDatasetSplit, string[]>([
      [CvDatasetSplit.TRAIN, []],
      [CvDatasetSplit.VALIDATION, []],
      [CvDatasetSplit.TEST, []],
    ]);
    for (const [groupKey, rows] of groups) {
      const bucket = splitBucket(`${tenantId}:${runId}:${groupKey}`);
      let split: CvDatasetSplit =
        bucket < trainCeiling
          ? CvDatasetSplit.TRAIN
          : bucket < validationCeiling
            ? CvDatasetSplit.VALIDATION
            : CvDatasetSplit.TEST;
      const touchesLowSku = rows.some(
        (row) => row.skuCodeSnapshot && lowSkus.has(row.skuCodeSnapshot),
      );
      const touchesLowAction = rows.some((row) =>
        lowActions.has(effectiveAction(row)),
      );
      if (touchesLowSku || touchesLowAction) {
        // Too few examples of this class to spread across splits: keep
        // the whole group in TRAIN and say so, instead of shipping a
        // test set whose per-class quality would be meaningless.
        if (touchesLowSku) {
          warnings.add('LOW_COVERAGE_SKU_FORCED_TRAIN');
        }
        if (touchesLowAction) {
          warnings.add('LOW_COVERAGE_ACTION_FORCED_TRAIN');
        }
        split = CvDatasetSplit.TRAIN;
      }
      assignment.get(split)!.push(...rows.map((row) => row.id));
    }
    if (eligible.length < SMALL_DATASET_THRESHOLD) {
      warnings.add('SMALL_DATASET');
    }

    await this.withRunLock(tenantId, runId, async (tx) => {
      for (const [split, ids] of assignment) {
        if (ids.length) {
          await tx.cvDatasetCandidate.updateMany({
            where: { tenantId, runId, id: { in: ids } },
            data: { split },
          });
        }
      }
    });
    return {
      runId,
      splitSummary: {
        TRAIN: assignment.get(CvDatasetSplit.TRAIN)!.length,
        VALIDATION: assignment.get(CvDatasetSplit.VALIDATION)!.length,
        TEST: assignment.get(CvDatasetSplit.TEST)!.length,
        HOLDOUT: 0,
      },
      groupCount: groups.size,
      warnings: [...warnings].sort(),
    };
  }

  // ------------------------------------------------------------------
  // export manifest
  // ------------------------------------------------------------------

  /** Safe JSON manifest for OFFLINE training: references, labels, and
   *  controlled metadata only. Requires READY (or a re-export from
   *  EXPORTED) and a complete split plan; stamps EXPORTED. */
  async exportManifest(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    if (
      run.status !== CvDatasetImprovementRunStatus.READY &&
      run.status !== CvDatasetImprovementRunStatus.EXPORTED
    ) {
      throw new BadRequestException(
        `a ${run.status} run cannot be exported — mark it READY first`,
      );
    }
    const internals = await this.qualityInternals(tenantId, run);
    if (internals.eligible.length === 0) {
      throw new BadRequestException(
        'no eligible candidates — refresh candidates first',
      );
    }
    if (!internals.splitsPlanned) {
      throw new BadRequestException('plan splits before exporting');
    }
    const splitOrder: Record<string, number> = {
      TRAIN: 0,
      VALIDATION: 1,
      TEST: 2,
      HOLDOUT: 3,
    };
    const rows = [...internals.eligible].sort(
      (a, b) =>
        splitOrder[a.split!] - splitOrder[b.split!] ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    const splitSummary = { TRAIN: 0, VALIDATION: 0, TEST: 0, HOLDOUT: 0 };
    for (const row of rows) {
      splitSummary[row.split!] += 1;
    }
    const skuSnapshots = new Map<string, { skuId: string | null; sku: string }>();
    for (const row of rows) {
      if (row.skuCodeSnapshot) {
        skuSnapshots.set(`${row.skuId ?? ''}:${row.skuCodeSnapshot}`, {
          skuId: row.skuId,
          sku: row.skuCodeSnapshot,
        });
      }
    }
    const actionLabels = [...new Set(rows.map(effectiveAction))].sort();

    // Calibration metadata snapshot (safe fields only — no zone labels,
    // no polygons, no source metadata). Null when nothing is linked.
    let calibration: {
      calibrationProfileId: string;
      name: string;
      calibrationVersion: number;
      orientation: string;
      cameraMount: string;
      zoneSummary: {
        total: number;
        shelfZones: number;
        interactionZones: number;
        ignoreZones: number;
        entryExitZones: number;
      };
    } | null = null;
    if (run.sourceCalibrationProfileId) {
      const profile = await this.prisma.cameraCalibrationProfile.findFirst({
        where: { tenantId, id: run.sourceCalibrationProfileId },
        select: {
          id: true,
          name: true,
          calibrationVersion: true,
          orientation: true,
          cameraMount: true,
        },
      });
      if (profile) {
        const zones = await this.prisma.cameraCalibrationZone.findMany({
          where: { tenantId, calibrationProfileId: profile.id },
          select: { zoneType: true },
        });
        const zoneCount = (zoneType: string) =>
          zones.filter((zone) => zone.zoneType === zoneType).length;
        calibration = {
          calibrationProfileId: profile.id,
          name: profile.name,
          calibrationVersion: profile.calibrationVersion,
          orientation: profile.orientation,
          cameraMount: profile.cameraMount,
          zoneSummary: {
            total: zones.length,
            shelfZones: zoneCount('SHELF_ZONE'),
            interactionZones: zoneCount('INTERACTION_ZONE'),
            ignoreZones: zoneCount('IGNORE_ZONE'),
            entryExitZones: zoneCount('ENTRY_EXIT_ZONE'),
          },
        };
      }
    }

    const warnings = [
      ...internals.imbalanceWarnings,
      ...internals.leakageWarnings,
      ...(internals.lowCoverageSkus.length ? ['LOW_COVERAGE_SKUS'] : []),
      ...(internals.lowCoverageActions.length ? ['LOW_COVERAGE_ACTIONS'] : []),
    ];
    const generatedAt = new Date();
    const manifest = {
      manifestVersion: 1,
      runId,
      tenantId,
      name: run.name,
      purpose: run.purpose,
      status: CvDatasetImprovementRunStatus.EXPORTED,
      generatedAt,
      splitPercents: {
        train: run.trainSplitPercent,
        validation: run.validationSplitPercent,
        test: run.testSplitPercent,
      },
      splitSummary,
      candidates: rows.map(toCandidateView),
      skuSnapshots: [...skuSnapshots.values()],
      actionLabels,
      calibration,
      warnings,
      trainingNotes: DATASET_TRAINING_NOTES,
      evidenceStatus: DATASET_EVIDENCE_STATUS,
    };
    await this.withRunLock(tenantId, runId, (tx) =>
      tx.cvDatasetImprovementRun.updateMany({
        where: { tenantId, id: runId },
        data: {
          status: CvDatasetImprovementRunStatus.EXPORTED,
          exportedAt: generatedAt,
        },
      }),
    );
    return {
      runId,
      manifestVersion: 1,
      rowCount: rows.length,
      generatedAt,
      manifest,
    };
  }

  // ------------------------------------------------------------------
  // model tuning report (advisory only)
  // ------------------------------------------------------------------

  /** ADVISORY ONLY: no training is invoked, no external model API is
   *  called, and no accuracy projection is ever produced. */
  async modelTuningReport(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    const internals = await this.qualityInternals(tenantId, run);
    const taskByPurpose: Record<CvDatasetPurpose, string> = {
      SKU_CLASSIFICATION: 'SKU_CLASSIFICATION',
      ACTION_RECOGNITION: 'ACTION_RECOGNITION',
      FALSE_TOUCH_FILTERING: 'FALSE_TOUCH_FILTERING',
      MISSED_EVENT_RECOVERY: 'ACTION_RECOGNITION',
      CALIBRATION_VALIDATION: 'MIXED',
      MIXED: 'MIXED',
    };
    const tuningReadiness: DatasetReadiness =
      internals.readiness === 'NOT_READY' || !internals.splitsPlanned
        ? 'NOT_READY'
        : internals.readiness === 'WARNING'
          ? 'WARNING'
          : 'READY';
    const suggestedCollectionPlan: string[] = [];
    if (internals.lowCoverageSkus.length) {
      suggestedCollectionPlan.push(
        'COLLECT_MORE_EXAMPLES_FOR_LOW_COVERAGE_SKUS',
      );
    }
    if (internals.lowCoverageActions.length) {
      suggestedCollectionPlan.push(
        'COLLECT_MORE_EXAMPLES_FOR_LOW_COVERAGE_ACTIONS',
      );
    }
    if (internals.missedEventCount === 0) {
      suggestedCollectionPlan.push('LABEL_MISSED_EVENTS_FOR_RECALL_EVIDENCE');
    }
    if (internals.falseTouchCount === 0) {
      suggestedCollectionPlan.push('LABEL_FALSE_TOUCHES_FOR_NEGATIVES');
    }
    const holdoutCount = internals.eligible.filter(
      (row) => row.split === CvDatasetSplit.HOLDOUT,
    ).length;
    const hasLowConfidence = internals.eligible.some(
      (row) => row.confidenceBucket === 'LOW',
    );
    return {
      runId,
      recommendedModelTask: taskByPurpose[run.purpose],
      datasetReadiness: internals.readiness,
      tuningReadiness,
      classCoverageSummary: {
        skuClasses: internals.skuCounts.size,
        actionClasses: internals.actionCounts.size,
        belowMinimumSkus: internals.lowCoverageSkus.length,
        belowMinimumActions: internals.lowCoverageActions.length,
      },
      likelyConfusionPairs: internals.confusionPairs
        ? internals.confusionPairs.sku.slice(0, 5)
        : [],
      suggestedCollectionPlan,
      suggestedEvaluationMetrics: [
        'PER_SKU_PRECISION',
        'PER_SKU_RECALL',
        'ACTION_CONFUSION_MATRIX',
        'FALSE_TOUCH_RATE',
        'MISSED_EVENT_RATE',
      ],
      suggestedHoldoutPlan: {
        holdoutCount,
        note: 'HOLDOUT_NOT_AUTO_ASSIGNED_IN_MVP',
      },
      recommendedThresholdReview: {
        suggested: hasLowConfidence,
        note: 'REVIEW_MATCH_SCORE_THRESHOLDS_WITH_OPERATOR',
      },
      recommendedNextActions: internals.recommendedNextActions,
      advisory: DATASET_TUNING_ADVISORY,
      safety: SAFETY,
    };
  }
}
