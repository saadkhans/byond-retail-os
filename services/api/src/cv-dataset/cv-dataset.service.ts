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
  GroundTruthEventKind,
  PilotExpectedAction,
  PilotObservationVerdict,
  Prisma,
} from '@prisma/client';
import { createHash } from 'node:crypto';
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
 *    INCONCLUSIVE records are EXCLUDED with a controlled reason, and a
 *    correction verdict without a real, different correction is
 *    excluded too;
 *  - references and enum/id snapshots only — never media, paths, URLs,
 *    credential slots, embeddings, or model weights;
 *  - this module writes ONLY its own two tables and never mutates the
 *    review/scenario/source records it reads (static guard enforced);
 *  - missing data is null/zero — never fabricated: missed-event reviews
 *    carry no evidence locator yet, so they are EXCLUDED, not exported
 *    as untraceable labels;
 *  - export re-validates the CURRENT source records under the run lock
 *    and refuses to ship a manifest that no longer matches them;
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

/** Below this many eligible examples the dataset is flagged SMALL — a
 *  DURABLE quality warning (readiness, tuning report, and manifest all
 *  carry it), not just a transient planner note. */
export const SMALL_DATASET_THRESHOLD = 30;

/** Controlled error tokens (messages START with these; submitted or
 *  source values are never echoed). */
export const DATASET_STALE_CANDIDATES = 'CV_DATASET_STALE_CANDIDATES';
export const DATASET_LINEAGE_MISMATCH = 'CV_DATASET_SOURCE_LINEAGE_MISMATCH';
export const DATASET_CALIBRATION_MISMATCH =
  'CV_DATASET_CALIBRATION_CAMERA_MISMATCH';
export const DATASET_SPLITS_REQUIRE_REPLAN = 'CV_DATASET_SPLITS_REQUIRE_REPLAN';
export const DATASET_CANDIDATES_REQUIRE_REFRESH =
  'CV_DATASET_CANDIDATES_REQUIRE_REFRESH';
export const DATASET_EXPORT_REQUIRES_PLANNED_SPLITS =
  'CV_DATASET_EXPORT_REQUIRES_PLANNED_SPLITS';

export const DATASET_EXCLUSION_REASONS = [
  'NOT_REVIEWED',
  'UNCERTAIN_VERDICT',
  'INCORRECT_VERDICT',
  'INCONCLUSIVE_RESULT',
  'MISSING_RESULT',
  'MISSING_EVIDENCE_LOCATOR',
  'MISSING_CORRECTED_SKU',
  'MISSING_CORRECTED_ACTION',
  'CORRECTION_NOT_DIFFERENT',
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

/** Action labels a trainer can actually use. UNKNOWN is not a label. */
const USABLE_ACTION_LABELS: readonly string[] = [
  PilotExpectedAction.PICKUP,
  PilotExpectedAction.RETURN,
  PilotExpectedAction.NO_OP,
];

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

interface CandidateSeed {
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
  scenarioTypeSnapshot: string | null;
  /** OPAQUE id of the operator-approved crop artifact the source
   *  review named as this candidate's evidence (null = the event's own
   *  automatic fusion crop). Reference marker only — never a path. */
  evidenceCropArtifactId: string | null;
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
  /** Operator-approved crop reference (OPAQUE artifact id) — null when
   *  the candidate's evidence is the event's automatic fusion crop. */
  evidenceCropArtifactId: string | null;
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
    evidenceCropArtifactId: row.evidenceCropArtifactId,
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

/** A SKU snapshot counts as a class LABEL only when the review actually
 *  confirmed or corrected the SKU (or a scripted scenario asserted it).
 *  A FALSE_TOUCH row's snapshot is the model's UNCONFIRMED prediction —
 *  the reviewer confirmed NO_OP, not the SKU identity — so it stays on
 *  the candidate as reference metadata but is never a SKU class. */
function confirmedSkuOf(row: {
  skuCodeSnapshot: string | null;
  reviewVerdict: string;
}): string | null {
  return row.reviewVerdict === PilotObservationVerdict.FALSE_TOUCH
    ? null
    : row.skuCodeSnapshot;
}

/** The INDEPENDENT-GROUP identity of a candidate. Same live session →
 *  same group (near-duplicate frames are one unit of evidence, not
 *  many); sessionless rows stand alone. Deliberately excludes the
 *  dataset run id so the same source group keeps the same split across
 *  every dataset improvement run and every replan (stable iterative
 *  comparisons, no evaluation-data drift into TRAIN). */
function groupKeyOf(row: {
  liveSessionId: string | null;
  sourceType: CvDatasetCandidateSourceType | string;
  sourceId: string;
}): string {
  return row.liveSessionId ?? `${row.sourceType}:${row.sourceId}`;
}

/** The action-family CLASS a row belongs to for the purpose-scoped
 *  split-coverage gates. FALSE_TOUCH_FILTERING is a BINARY task — NO_OP
 *  negatives vs positive touches, where PICKUP and RETURN both provide
 *  positive-touch coverage — so its gates must never demand TRAIN
 *  coverage for every individual action label (a RETURN-only group
 *  hashing into TEST must not block a run whose PICKUP examples already
 *  cover the positive class). Every other purpose gates per individual
 *  label. Returns null for labels outside the binary family. */
function actionGateClassOf(
  purpose: CvDatasetPurpose,
  action: string,
): string | null {
  if (purpose !== CvDatasetPurpose.FALSE_TOUCH_FILTERING) {
    return action;
  }
  if (action === PilotExpectedAction.NO_OP) {
    return 'NEGATIVE_NO_OP';
  }
  if (
    action === PilotExpectedAction.PICKUP ||
    action === PilotExpectedAction.RETURN
  ) {
    return 'POSITIVE_TOUCH';
  }
  return null;
}

/** The manifest's calibration section — SAFE metadata only (no zone
 *  labels, polygons, product details, or camera identifiers). Built
 *  from the SAME single profile+zone read that freshness validation
 *  fingerprints, so the manifest can never describe different content
 *  than what was validated. */
export interface CalibrationSnapshot {
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
}

/** sha256 over SAFE calibration content. Any profile metadata edit and
 *  any zone ADDITION, UPDATE, or DELETION changes the digest: zone ids
 *  and counts move on membership changes, updatedAt moves on edits.
 *  Zone ids feed the digest but are never surfaced in responses or
 *  errors. Nothing sensitive is hashed — no labels, polygons, expected
 *  products, sources, paths, or credentials. */
export function calibrationContentFingerprint(
  profile: {
    id: string;
    calibrationVersion: number;
    orientation: string;
    cameraMount: string;
    updatedAt: Date;
  },
  zones: { id: string; zoneType: string; updatedAt: Date }[],
): string {
  const zoneCountByType: Record<string, number> = {};
  for (const zone of [...zones].sort((a, b) =>
    a.zoneType.localeCompare(b.zoneType),
  )) {
    zoneCountByType[zone.zoneType] = (zoneCountByType[zone.zoneType] ?? 0) + 1;
  }
  const canonical = JSON.stringify({
    calibrationProfileId: profile.id,
    calibrationVersion: profile.calibrationVersion,
    orientation: profile.orientation,
    cameraMount: profile.cameraMount,
    profileUpdatedAt: profile.updatedAt.toISOString(),
    zoneCount: zones.length,
    zoneCountByType,
    zoneIds: zones.map((zone) => zone.id).sort(),
    maxZoneUpdatedAt: zones.length
      ? new Date(
          Math.max(...zones.map((zone) => zone.updatedAt.getTime())),
        ).toISOString()
      : null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Label families a task can train on, counted over ELIGIBLE rows. */
interface LabelFamilies {
  skuLabeled: number;
  actionLabeled: number;
  falseTouchPair: boolean;
  missedRecovery: number;
}

function labelFamilies(
  eligible: {
    sourceType: CvDatasetCandidateSourceType;
    skuCodeSnapshot: string | null;
    actionLabel: string;
    correctedActionLabel: string | null;
    reviewVerdict: string;
  }[],
): LabelFamilies {
  let skuLabeled = 0;
  let actionLabeled = 0;
  let noOp = 0;
  let positives = 0;
  let missedRecovery = 0;
  for (const row of eligible) {
    // FALSE_TOUCH predicted SKUs are NOT confirmed SKU labels.
    if (confirmedSkuOf(row) !== null) {
      skuLabeled += 1;
    }
    const action = effectiveAction(row);
    if (USABLE_ACTION_LABELS.includes(action)) {
      actionLabeled += 1;
    }
    if (action === PilotExpectedAction.NO_OP) {
      noOp += 1;
    }
    if (
      action === PilotExpectedAction.PICKUP ||
      action === PilotExpectedAction.RETURN
    ) {
      positives += 1;
    }
    if (row.sourceType === CvDatasetCandidateSourceType.MISSED_EVENT) {
      missedRecovery += 1;
    }
  }
  return {
    skuLabeled,
    actionLabeled,
    falseTouchPair: noOp > 0 && positives > 0,
    missedRecovery,
  };
}

/** Purpose-aware label requirement: a run must not read READY (or
 *  export) for a task it has zero usable labels for. */
function purposeLabelCheck(
  purpose: CvDatasetPurpose,
  families: LabelFamilies,
): { satisfied: boolean; warnings: string[] } {
  switch (purpose) {
    case CvDatasetPurpose.SKU_CLASSIFICATION:
      return families.skuLabeled > 0
        ? { satisfied: true, warnings: [] }
        : { satisfied: false, warnings: ['NO_SKU_LABELS_FOR_TASK'] };
    case CvDatasetPurpose.ACTION_RECOGNITION:
      return families.actionLabeled > 0
        ? { satisfied: true, warnings: [] }
        : { satisfied: false, warnings: ['NO_ACTION_LABELS_FOR_TASK'] };
    case CvDatasetPurpose.FALSE_TOUCH_FILTERING:
      return families.falseTouchPair
        ? { satisfied: true, warnings: [] }
        : { satisfied: false, warnings: ['INSUFFICIENT_TASK_LABELS'] };
    case CvDatasetPurpose.MISSED_EVENT_RECOVERY:
      return families.missedRecovery > 0
        ? { satisfied: true, warnings: [] }
        : { satisfied: false, warnings: ['INSUFFICIENT_TASK_LABELS'] };
    default: {
      // MIXED / CALIBRATION_VALIDATION: at least one usable family, and
      // the missing families are called out as warnings.
      const any =
        families.skuLabeled > 0 ||
        families.actionLabeled > 0 ||
        families.falseTouchPair ||
        families.missedRecovery > 0;
      if (!any) {
        return { satisfied: false, warnings: ['INSUFFICIENT_TASK_LABELS'] };
      }
      const warnings: string[] = [];
      if (families.skuLabeled === 0) {
        warnings.push('NO_SKU_LABELS_FOR_TASK');
      }
      if (families.actionLabeled === 0) {
        warnings.push('NO_ACTION_LABELS_FOR_TASK');
      }
      return { satisfied: true, warnings };
    }
  }
}

/** Which class families does this purpose actually TRAIN on? The
 *  split-coverage GATES (missing-TRAIN blocks and the evaluation-split
 *  warnings) apply only to the families the task trains: a
 *  SKU_CLASSIFICATION run must not be blocked because an irrelevant
 *  corrected-action class hashed outside TRAIN, and vice versa.
 *  Group-minimum warnings stay global — they describe the dataset, not
 *  the task. Stable split ASSIGNMENT is purpose-independent. */
function purposeTrainsSkuClasses(purpose: CvDatasetPurpose): boolean {
  return (
    purpose === CvDatasetPurpose.SKU_CLASSIFICATION ||
    purpose === CvDatasetPurpose.MIXED ||
    purpose === CvDatasetPurpose.CALIBRATION_VALIDATION
  );
}

function purposeTrainsActionClasses(purpose: CvDatasetPurpose): boolean {
  // ACTION_RECOGNITION, FALSE_TOUCH_FILTERING (NO_OP negatives +
  // positive actions), MISSED_EVENT_RECOVERY (action-family recovery
  // labels), MIXED, and CALIBRATION_VALIDATION all train action-family
  // classes; only a pure SKU task does not.
  return purpose !== CvDatasetPurpose.SKU_CLASSIFICATION;
}

function taskUsable(task: string, families: LabelFamilies): boolean {
  if (task === 'SKU_CLASSIFICATION') {
    return families.skuLabeled > 0;
  }
  if (task === 'ACTION_RECOGNITION') {
    return families.actionLabeled > 0;
  }
  if (task === 'FALSE_TOUCH_FILTERING') {
    return families.falseTouchPair;
  }
  return (
    families.skuLabeled > 0 ||
    families.actionLabeled > 0 ||
    families.falseTouchPair ||
    families.missedRecovery > 0
  );
}

/** Verdicts whose rows can become ELIGIBLE candidates. Superset of the
 *  Phase 15 export list by FALSE_TOUCH: a confirmed false touch is a
 *  REVIEWED corrected NEGATIVE (label NO_OP) — exactly what a
 *  false-touch filter trains on. INCORRECT/UNCERTAIN stay excluded:
 *  they carry no usable label. WRONG_SKU/WRONG_ACTION additionally
 *  require a real, different correction (validated per row). */

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

  /** Serializes refresh / plan / export / status per run. Every state
   *  read that feeds a mutation happens INSIDE this lock — never
   *  before it — so refresh, split planning, status changes, and
   *  export can never interleave into an inconsistent EXPORTED run. */
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

  /** Re-reads the run inside the lock (the pre-lock row may be stale). */
  private async lockedRun(
    tx: Prisma.TransactionClient,
    tenantId: string,
    runId: string,
  ) {
    const run = await tx.cvDatasetImprovementRun.findFirst({
      where: { tenantId, id: runId },
    });
    if (!run) {
      throw new NotFoundException('Dataset improvement run not found');
    }
    return run;
  }

  /** Tenant-scoped validation of the three optional source links, plus
   *  the evaluation/protocol LINEAGE rule: when both are linked, the
   *  protocol must actually be bound to that same evaluation run. */
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
        select: { id: true, evaluationRunId: true },
      });
      if (!protocol) {
        throw new NotFoundException('Test protocol not found');
      }
      if (
        links.sourceEvaluationRunId &&
        protocol.evaluationRunId !== links.sourceEvaluationRunId
      ) {
        throw new BadRequestException(
          `${DATASET_LINEAGE_MISMATCH}: the linked test protocol is bound to a different evaluation run`,
        );
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

  /** Tenant-scoped camera lookup for the live sessions behind a set of
   *  candidates (READ only — safe metadata, no source strings). */
  private async sessionCameras(
    tenantId: string,
    sessionIds: string[],
  ): Promise<Map<string, { cameraSourceId: string; sourceType: string }>> {
    if (!sessionIds.length) {
      return new Map();
    }
    // Two explicitly tenant-scoped queries — NEVER the nested
    // session→cameraSource relation, which is not tenant-checked: a
    // malformed session row pointing at another tenant's camera must
    // not let that camera's sourceType drive the FILE_REPLAY
    // calibration exemption or readiness advice. A cameraSourceId that
    // does not resolve within the tenant is treated as UNKNOWN, which
    // is never FILE_REPLAY-exempt and never matches a calibration
    // profile's camera.
    const sessions = await this.prisma.liveCameraSession.findMany({
      where: { tenantId, id: { in: sessionIds } },
      select: { id: true, cameraSourceId: true },
    });
    const cameraSourceIds = [
      ...new Set(sessions.map((row) => row.cameraSourceId)),
    ];
    const sources = cameraSourceIds.length
      ? await this.prisma.cameraSource.findMany({
          where: { tenantId, id: { in: cameraSourceIds } },
          select: { id: true, sourceType: true },
        })
      : [];
    const sourceTypeById = new Map(
      sources.map((row) => [row.id, row.sourceType as string]),
    );
    return new Map(
      sessions.map((row) => [
        row.id,
        {
          cameraSourceId: row.cameraSourceId,
          sourceType: sourceTypeById.get(row.cameraSourceId) ?? 'UNKNOWN',
        },
      ]),
    );
  }

  /** ONE tenant-scoped read of the linked calibration profile + zones,
   *  returning the manifest snapshot AND its content fingerprint
   *  together. Export validates the fingerprint and then populates the
   *  manifest from this exact object — there is deliberately no second
   *  profile/zone read a concurrent edit could slip between. Null when
   *  the profile no longer exists. */
  private async readCalibrationSnapshot(
    db: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    profileId: string,
  ): Promise<{ snapshot: CalibrationSnapshot; fingerprint: string } | null> {
    const profile = await db.cameraCalibrationProfile.findFirst({
      where: { tenantId, id: profileId },
      select: {
        id: true,
        name: true,
        calibrationVersion: true,
        orientation: true,
        cameraMount: true,
        updatedAt: true,
      },
    });
    if (!profile) {
      return null;
    }
    const zones = await db.cameraCalibrationZone.findMany({
      where: { tenantId, calibrationProfileId: profileId },
      select: { id: true, zoneType: true, updatedAt: true },
    });
    const zoneCount = (zoneType: string) =>
      zones.filter((zone) => zone.zoneType === zoneType).length;
    return {
      snapshot: {
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
      },
      fingerprint: calibrationContentFingerprint(profile, zones),
    };
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
    await this.requireRun(tenantId, runId);
    // Config changes and plan invalidation are ATOMIC under the run
    // lock: a manifest can never advertise new percentages/minimums
    // over split assignments planned for the old configuration.
    const warnings = await this.withRunLock(tenantId, runId, async (tx) => {
      const run = await this.lockedRun(tx, tenantId, runId);
      if (run.status !== CvDatasetImprovementRunStatus.DRAFT) {
        throw new BadRequestException('only DRAFT runs can be edited');
      }
      const data: Prisma.CvDatasetImprovementRunUncheckedUpdateManyInput = {};
      if (input.name !== undefined) {
        const name = this.screenText(
          'name',
          input.name,
          DATASET_RUN_NAME_MAX_LENGTH,
        );
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

      // Which planning inputs actually changed?
      const planningChanged =
        percents.trainSplitPercent !== run.trainSplitPercent ||
        percents.validationSplitPercent !== run.validationSplitPercent ||
        percents.testSplitPercent !== run.testSplitPercent ||
        (input.minReviewedExamplesPerSku != null &&
          input.minReviewedExamplesPerSku !== run.minReviewedExamplesPerSku) ||
        (input.minReviewedExamplesPerAction != null &&
          input.minReviewedExamplesPerAction !==
            run.minReviewedExamplesPerAction) ||
        (input.purpose != null && input.purpose !== run.purpose);
      const linksChanged =
        links.sourceEvaluationRunId !== run.sourceEvaluationRunId ||
        links.sourceTestProtocolId !== run.sourceTestProtocolId ||
        links.sourceCalibrationProfileId !== run.sourceCalibrationProfileId;
      const existing = await tx.cvDatasetCandidate.findMany({
        where: { tenantId, runId },
        select: { split: true },
      });
      const hadSplits = existing.some((row) => row.split !== null);

      await tx.cvDatasetImprovementRun.updateMany({
        where: { tenantId, id: runId },
        data,
      });
      const changeWarnings: string[] = [];
      if (linksChanged && existing.length) {
        // The candidate ledger (and its refresh-time calibration
        // fingerprint) describes the OLD source family.
        await tx.cvDatasetImprovementRun.updateMany({
          where: { tenantId, id: runId },
          data: { calibrationFingerprint: null },
        });
        await tx.cvDatasetCandidate.deleteMany({ where: { tenantId, runId } });
        if (hadSplits) {
          changeWarnings.push(DATASET_SPLITS_REQUIRE_REPLAN);
        }
        changeWarnings.push(DATASET_CANDIDATES_REQUIRE_REFRESH);
      } else if (planningChanged && hadSplits) {
        // Existing assignments were planned for the old configuration.
        await tx.cvDatasetCandidate.updateMany({
          where: { tenantId, runId },
          data: { split: null },
        });
        changeWarnings.push(DATASET_SPLITS_REQUIRE_REPLAN);
      }
      return changeWarnings;
    });
    const detail = await this.runDetail(tenantId, runId);
    return { ...detail, warnings };
  }

  /** DRAFT → READY (gated on the honest, purpose-aware quality
   *  readiness — re-checked under the run lock) and
   *  anything-but-ARCHIVED → ARCHIVED. EXPORTED is stamped only by the
   *  export endpoint. */
  async setStatus(
    tenantId: string,
    runId: string,
    status: CvDatasetImprovementRunStatus,
  ) {
    await this.requireRun(tenantId, runId);
    if (status === CvDatasetImprovementRunStatus.ARCHIVED) {
      await this.withRunLock(tenantId, runId, async (tx) => {
        const current = await this.lockedRun(tx, tenantId, runId);
        if (current.status === CvDatasetImprovementRunStatus.ARCHIVED) {
          throw new BadRequestException('run is already ARCHIVED');
        }
        await tx.cvDatasetImprovementRun.updateMany({
          where: { tenantId, id: runId },
          data: {
            status: CvDatasetImprovementRunStatus.ARCHIVED,
            archivedAt: new Date(),
          },
        });
      });
      return this.runDetail(tenantId, runId);
    }
    if (status === CvDatasetImprovementRunStatus.READY) {
      await this.withRunLock(tenantId, runId, async (tx) => {
        const current = await this.lockedRun(tx, tenantId, runId);
        if (current.status !== CvDatasetImprovementRunStatus.DRAFT) {
          throw new BadRequestException('only DRAFT runs can become READY');
        }
        const internals = await this.qualityInternals(tenantId, current, tx);
        if (internals.readiness === 'NOT_READY') {
          throw new BadRequestException(
            'run is not ready: minimum reviewed data is missing',
          );
        }
        await tx.cvDatasetImprovementRun.updateMany({
          where: { tenantId, id: runId },
          data: { status: CvDatasetImprovementRunStatus.READY },
        });
      });
      return this.runDetail(tenantId, runId);
    }
    throw new BadRequestException('status must be READY or ARCHIVED');
  }

  // ------------------------------------------------------------------
  // candidate collection (reviewed/corrected only)
  // ------------------------------------------------------------------

  /** Derives the candidate seeds from the CURRENT linked sources.
   *  Candidates are REFERENCES + safe snapshots; the source records are
   *  never mutated. lightingBucket/occlusionBucket/calibrationZoneLabel
   *  stay null in the MVP — no source data exists for them, and Phase
   *  18 never fabricates values. DATASET_EXPORT_ITEM is reserved and
   *  never emitted here. Also used by export to detect STALE candidate
   *  ledgers. */
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
      // Ground-truth drift guard (Codex P1): video-bootstrap reviews bind
      // labels at review time, but VideoGroundTruth is EDITABLE — a
      // candidate whose effective labels contradict the clip's CURRENT
      // truth would export mislabeled data. Live observations carry no
      // video asset and are unaffected.
      const truthAssetIds = [
        ...new Set(
          observations
            .map((observation) => observation.videoAssetId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const truthRows = truthAssetIds.length
        ? await this.prisma.videoGroundTruth.findMany({
            where: { tenantId, videoAssetId: { in: truthAssetIds } },
            select: {
              videoAssetId: true,
              eventKind: true,
              productId: true,
              product: { select: { sku: true } },
            },
          })
        : [];
      const truthByAsset = new Map(
        truthRows.map((row) => [row.videoAssetId, row]),
      );
      // Deleted source media (Codex P1): the asset delete flow removes
      // the footage and soft-deletes the row while keeping ground-truth
      // and shadow-event rows for audit — a candidate whose clip no
      // longer exists must never stay ELIGIBLE or export a manifest
      // reference to footage that is gone. Export freshness recomputes
      // these seeds, so a post-refresh deletion also blocks the export.
      const liveVideoAssetIds = new Set(
        truthAssetIds.length
          ? (
              await this.prisma.videoAsset.findMany({
                where: {
                  tenantId,
                  id: { in: truthAssetIds },
                  deletedAt: null,
                },
                select: { id: true },
              })
            ).map((row) => row.id)
          : [],
      );
      for (const observation of observations) {
        const predictedAction = predictedActionOf(observation.eventType);
        const review = observation.latestReview;
        const truth = observation.videoAssetId
          ? (truthByAsset.get(observation.videoAssetId) ?? null)
          : null;
        // Demote an otherwise-ELIGIBLE seed whose effective labels no
        // longer match the clip's current ground truth. Never rewrites
        // the review row — a fresh review restores eligibility.
        const guardCurrentTruth = (seed: CandidateSeed): CandidateSeed => {
          if (seed.eligibility !== CvDatasetEligibility.ELIGIBLE || !truth) {
            return seed;
          }
          const effectiveAction = seed.correctedActionLabel ?? seed.actionLabel;
          const truthAction =
            truth.eventKind === GroundTruthEventKind.NONE
              ? PilotExpectedAction.NO_OP
              : truth.eventKind === GroundTruthEventKind.RETURN
                ? PilotExpectedAction.RETURN
                : PilotExpectedAction.PICKUP;
          const actionMatches = effectiveAction === truthAction;
          // Product-ID equality is canonical when both ids are known;
          // the SKU snapshot is the fallback. Negatives carry no product.
          const productMatches =
            truthAction === PilotExpectedAction.NO_OP
              ? true
              : seed.skuId !== null && truth.productId !== null
                ? seed.skuId === truth.productId
                : seed.skuCodeSnapshot !== null &&
                  (truth.product?.sku ?? null) !== null &&
                  seed.skuCodeSnapshot === truth.product?.sku;
          return actionMatches && productMatches
            ? seed
            : {
                ...seed,
                eligibility: CvDatasetEligibility.EXCLUDED,
                exclusionReason: 'STALE_GROUND_TRUTH',
              };
        };
        const base = {
          sourceType: CvDatasetCandidateSourceType.LIVE_REVIEW,
          sourceId: observation.journeyEventId,
          liveSessionId: observation.liveSessionId,
          evaluationRunId: run.sourceEvaluationRunId,
          protocolId: null,
          calibrationProfileId: null,
          actionLabel: predictedAction,
          reviewSource: 'PILOT_EVALUATION',
          confidenceBucket: confidenceBucketOf(observation.matchScore),
          scenarioTypeSnapshot: null,
          // STRUCTURED operator-crop evidence override from the review
          // (one-SKU bootstrap) — the candidate resolves to the crop the
          // operator approved, not the rejected automatic one. Never
          // parsed from notes.
          evidenceCropArtifactId: review?.operatorCropArtifactId ?? null,
        };
        const excluded = (
          verdict: string,
          exclusionReason: string,
        ): CandidateSeed => ({
          ...base,
          skuId: observation.predictedProductId,
          skuCodeSnapshot: observation.predictedSku,
          correctedActionLabel: null,
          reviewVerdict: verdict,
          eligibility: CvDatasetEligibility.EXCLUDED,
          exclusionReason,
        });
        // A video-backed observation whose source clip was deleted has
        // no footage an offline trainer could resolve — EXCLUDED, and a
        // stored ELIGIBLE row goes stale against this recomputed seed.
        if (
          observation.videoAssetId &&
          !liveVideoAssetIds.has(observation.videoAssetId)
        ) {
          seeds.push(
            excluded(review?.verdict ?? 'UNREVIEWED', 'SOURCE_MEDIA_DELETED'),
          );
          continue;
        }
        if (!review) {
          seeds.push(excluded('UNREVIEWED', 'NOT_REVIEWED'));
          continue;
        }
        if (review.verdict === PilotObservationVerdict.CORRECT) {
          seeds.push(
            guardCurrentTruth({
              ...base,
              skuId: observation.predictedProductId,
              skuCodeSnapshot: observation.predictedSku,
              correctedActionLabel: null,
              reviewVerdict: review.verdict,
              eligibility: CvDatasetEligibility.ELIGIBLE,
              exclusionReason: null,
            }),
          );
          continue;
        }
        if (review.verdict === PilotObservationVerdict.FALSE_TOUCH) {
          // A confirmed false touch is a reviewed corrected NEGATIVE.
          seeds.push(
            guardCurrentTruth({
              ...base,
              skuId: observation.predictedProductId,
              skuCodeSnapshot: observation.predictedSku,
              correctedActionLabel: PilotExpectedAction.NO_OP,
              reviewVerdict: review.verdict,
              eligibility: CvDatasetEligibility.ELIGIBLE,
              exclusionReason: null,
            }),
          );
          continue;
        }
        if (review.verdict === PilotObservationVerdict.WRONG_SKU) {
          // A correction verdict needs a REAL correction: a corrected
          // SKU that exists and differs from the prediction.
          const correctedSku = review.expectedSku ?? null;
          const correctedProductId = review.expectedProductId ?? null;
          if (!correctedSku && !correctedProductId) {
            seeds.push(excluded(review.verdict, 'MISSING_CORRECTED_SKU'));
            continue;
          }
          // Product-ID equality is CANONICAL whenever both ids exist:
          // the same product with a differing (or missing) SKU snapshot
          // is still not a correction. SKU-snapshot comparison is only
          // the fallback when the ids are not both known.
          const bothIds =
            correctedProductId !== null &&
            observation.predictedProductId !== null;
          const sameProduct =
            bothIds && correctedProductId === observation.predictedProductId;
          const sameSku =
            !bothIds &&
            correctedSku !== null &&
            observation.predictedSku !== null &&
            correctedSku === observation.predictedSku;
          if (sameSku || sameProduct) {
            seeds.push(excluded(review.verdict, 'CORRECTION_NOT_DIFFERENT'));
            continue;
          }
          seeds.push(
            guardCurrentTruth({
              ...base,
              skuId: correctedProductId,
              skuCodeSnapshot: correctedSku,
              correctedActionLabel: null,
              reviewVerdict: review.verdict,
              eligibility: CvDatasetEligibility.ELIGIBLE,
              exclusionReason: null,
            }),
          );
          continue;
        }
        if (review.verdict === PilotObservationVerdict.WRONG_ACTION) {
          // A corrected action must be a usable label (never UNKNOWN)
          // and must actually differ from the prediction.
          const corrected = review.expectedAction;
          if (!USABLE_ACTION_LABELS.includes(corrected)) {
            seeds.push(excluded(review.verdict, 'MISSING_CORRECTED_ACTION'));
            continue;
          }
          if (corrected === predictedAction) {
            seeds.push(excluded(review.verdict, 'CORRECTION_NOT_DIFFERENT'));
            continue;
          }
          seeds.push(
            guardCurrentTruth({
              ...base,
              skuId: review.expectedProductId ?? observation.predictedProductId,
              skuCodeSnapshot: review.expectedSku ?? observation.predictedSku,
              correctedActionLabel: corrected,
              reviewVerdict: review.verdict,
              eligibility: CvDatasetEligibility.ELIGIBLE,
              exclusionReason: null,
            }),
          );
          continue;
        }
        seeds.push(
          excluded(
            review.verdict,
            review.verdict === PilotObservationVerdict.UNCERTAIN
              ? 'UNCERTAIN_VERDICT'
              : 'INCORRECT_VERDICT',
          ),
        );
      }
      for (const missed of missedEvents) {
        // A missed-event review names a session and a label but carries
        // NO temporal/evidence locator (the review timestamp is when the
        // operator wrote it, not when the interaction happened). An
        // offline trainer cannot map it to footage, so it is EXCLUDED —
        // counted, surfaced, never pretended training-ready.
        seeds.push({
          sourceType: CvDatasetCandidateSourceType.MISSED_EVENT,
          sourceId: missed.reviewId,
          liveSessionId: missed.liveSessionId,
          evaluationRunId: run.sourceEvaluationRunId,
          protocolId: null,
          calibrationProfileId: null,
          skuId: missed.expectedProductId,
          skuCodeSnapshot: missed.expectedSku,
          actionLabel: missed.expectedAction,
          correctedActionLabel: null,
          reviewVerdict: PilotObservationVerdict.MISSED_EVENT,
          reviewSource: 'PILOT_EVALUATION',
          confidenceBucket: null,
          scenarioTypeSnapshot: null,
          evidenceCropArtifactId: null,
          eligibility: CvDatasetEligibility.EXCLUDED,
          exclusionReason: 'MISSING_EVIDENCE_LOCATOR',
        });
      }
    }
    if (run.sourceTestProtocolId) {
      const protocol = await this.prisma.cvTestProtocol.findFirst({
        where: { tenantId, id: run.sourceTestProtocolId },
        select: { id: true, evaluationRunId: true },
      });
      if (!protocol) {
        throw new NotFoundException('Test protocol not found');
      }
      // LINEAGE: scenario evidence belongs to the protocol's OWN
      // evaluation run — never to an unrelated linked run.
      if (
        run.sourceEvaluationRunId &&
        protocol.evaluationRunId !== run.sourceEvaluationRunId
      ) {
        throw new BadRequestException(
          `${DATASET_LINEAGE_MISMATCH}: the linked test protocol is bound to a different evaluation run`,
        );
      }
      const scenarioEvaluationRunId = protocol.evaluationRunId ?? null;
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
          evaluationRunId: scenarioEvaluationRunId,
          protocolId: run.sourceTestProtocolId,
          calibrationProfileId: null,
          skuId: scenario.expectedProductId,
          skuCodeSnapshot: scenario.expectedSku,
          actionLabel: scenario.expectedAction,
          correctedActionLabel: null,
          reviewVerdict: scenario.result ?? 'PENDING',
          reviewSource: 'CV_TEST_PROTOCOL',
          confidenceBucket: null,
          scenarioTypeSnapshot: scenario.scenarioType,
          evidenceCropArtifactId: null,
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
    // Calibration stamping: the linked profile must describe the camera
    // the footage actually came from. FILE_REPLAY sessions are exempt
    // (calibration is NOT_APPLICABLE to them) and never stamped.
    const sessionIds = [
      ...new Set(
        seeds
          .map((seed) => seed.liveSessionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const cameras = await this.sessionCameras(tenantId, sessionIds);
    if (run.sourceCalibrationProfileId) {
      const profile = await this.prisma.cameraCalibrationProfile.findFirst({
        where: { tenantId, id: run.sourceCalibrationProfileId },
        select: { id: true, cameraSourceId: true },
      });
      if (!profile) {
        throw new NotFoundException('Calibration profile not found');
      }
      for (const camera of cameras.values()) {
        if (
          camera.sourceType !== 'FILE_REPLAY' &&
          camera.cameraSourceId !== profile.cameraSourceId
        ) {
          throw new BadRequestException(
            `${DATASET_CALIBRATION_MISMATCH}: the linked calibration profile belongs to a different camera than the run's live sessions`,
          );
        }
      }
      for (const seed of seeds) {
        const camera = seed.liveSessionId
          ? cameras.get(seed.liveSessionId)
          : undefined;
        seed.calibrationProfileId =
          camera &&
          camera.sourceType !== 'FILE_REPLAY' &&
          camera.cameraSourceId === profile.cameraSourceId
            ? profile.id
            : null;
      }
    }
    return seeds;
  }

  /** Delete + rebuild the candidate ledger under the run lock (never
   *  touches the source records). Zero linked sources → zero rows,
   *  reported plainly. Rejected once EXPORTED — the exported snapshot
   *  must keep describing the manifest that was handed out. */
  async refreshCandidates(tenantId: string, runId: string) {
    await this.requireRun(tenantId, runId);
    return this.withRunLock(tenantId, runId, async (tx) => {
      const run = await this.lockedRun(tx, tenantId, runId);
      if (
        run.status === CvDatasetImprovementRunStatus.ARCHIVED ||
        run.status === CvDatasetImprovementRunStatus.EXPORTED
      ) {
        throw new BadRequestException(
          `candidates cannot be refreshed on a ${run.status} run`,
        );
      }
      const seeds = await this.collectCandidates(tenantId, run);
      await tx.cvDatasetCandidate.deleteMany({ where: { tenantId, runId } });
      if (seeds.length) {
        await tx.cvDatasetCandidate.createMany({
          data: seeds.map((seed) => ({
            tenantId,
            runId,
            lightingBucket: null,
            occlusionBucket: null,
            calibrationZoneLabel: null,
            split: null,
            ...seed,
          })),
        });
      }
      // Capture the refresh-time calibration CONTENT fingerprint when
      // the linked profile is actually stamped on eligible candidates.
      // Export recomputes and compares, so profile edits and zone
      // additions/updates/DELETIONS after this instant reject the
      // export instead of silently changing the manifest. Null when no
      // profile is linked or nothing is stamped (FILE_REPLAY footage is
      // never stamped — calibration stays NOT_APPLICABLE to it).
      const profileStamped =
        run.sourceCalibrationProfileId !== null &&
        seeds.some(
          (seed) =>
            seed.eligibility === CvDatasetEligibility.ELIGIBLE &&
            seed.calibrationProfileId === run.sourceCalibrationProfileId,
        );
      const calibration =
        profileStamped && run.sourceCalibrationProfileId
          ? await this.readCalibrationSnapshot(
              tx,
              tenantId,
              run.sourceCalibrationProfileId,
            )
          : null;
      await tx.cvDatasetImprovementRun.updateMany({
        where: { tenantId, id: runId },
        data: { calibrationFingerprint: calibration?.fingerprint ?? null },
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
    });
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
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const candidates = await db.cvDatasetCandidate.findMany({
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

    // SKU classes are CONFIRMED labels only (false-touch predicted SKUs
    // are reference metadata, never a class — see confirmedSkuOf).
    const skuCounts = countBy(eligible.map((row) => confirmedSkuOf(row)));
    const actionCounts = countBy(eligible.map((row) => effectiveAction(row)));
    const scenarioCounts = countBy(
      eligible.map((row) => row.scenarioTypeSnapshot),
    );
    const sourceTypeCounts = countBy(eligible.map((row) => row.sourceType));
    const profileCounts = countBy(
      eligible.map((row) => row.calibrationProfileId),
    );
    // Missed events are counted whether or not they are ELIGIBLE — in
    // the MVP they are all EXCLUDED (no evidence locator), but they are
    // still the run's recall evidence and must stay visible.
    const missedEventCount = candidates.filter(
      (row) => row.sourceType === CvDatasetCandidateSourceType.MISSED_EVENT,
    ).length;
    const falseTouchCount = eligible.filter(
      (row) => row.reviewVerdict === PilotObservationVerdict.FALSE_TOUCH,
    ).length;

    // INDEPENDENT-GROUP coverage: one session with many near-duplicate
    // examples is ONE unit of evidence, not many.
    const skuGroups = new Map<string, Set<string>>();
    const actionGroups = new Map<string, Set<string>>();
    const skuSplits = new Map<string, Set<string>>();
    const actionSplits = new Map<string, Set<string>>();
    // GATE maps: keyed by the purpose's trainable action class — for
    // FALSE_TOUCH_FILTERING that is the BINARY NO_OP-vs-positive-touch
    // pair, for every other purpose the individual label (identical to
    // actionGroups/actionSplits then). Only the gates read these; the
    // per-label maps keep describing the dataset (minimums, imbalance).
    const gateActionGroups = new Map<string, Set<string>>();
    const gateActionSplits = new Map<string, Set<string>>();
    for (const row of eligible) {
      const groupKey = groupKeyOf(row);
      const action = effectiveAction(row);
      const confirmedSku = confirmedSkuOf(row);
      if (confirmedSku) {
        const groups = skuGroups.get(confirmedSku) ?? new Set<string>();
        groups.add(groupKey);
        skuGroups.set(confirmedSku, groups);
        if (row.split) {
          const splits = skuSplits.get(confirmedSku) ?? new Set<string>();
          splits.add(row.split);
          skuSplits.set(confirmedSku, splits);
        }
      }
      const groups = actionGroups.get(action) ?? new Set<string>();
      groups.add(groupKey);
      actionGroups.set(action, groups);
      if (row.split) {
        const splits = actionSplits.get(action) ?? new Set<string>();
        splits.add(row.split);
        actionSplits.set(action, splits);
      }
      const gateClass = actionGateClassOf(run.purpose, action);
      if (gateClass !== null) {
        const gateGroups =
          gateActionGroups.get(gateClass) ?? new Set<string>();
        gateGroups.add(groupKey);
        gateActionGroups.set(gateClass, gateGroups);
        if (row.split) {
          const gateSplits =
            gateActionSplits.get(gateClass) ?? new Set<string>();
          gateSplits.add(row.split);
          gateActionSplits.set(gateClass, gateSplits);
        }
      }
    }

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

    // Minimum class coverage is measured in INDEPENDENT GROUPS, not raw
    // candidate rows: 30 near-duplicates from two sessions are two units
    // of evidence, and never satisfy a minimum of five. Raw counts are
    // still reported — they are just never the readiness basis.
    const lowCoverageSkus = [...skuCounts.entries()]
      .map(([sku, count]) => ({
        sku,
        count,
        groups: skuGroups.get(sku)?.size ?? 0,
        minimum: run.minReviewedExamplesPerSku,
      }))
      .filter((entry) => entry.groups < run.minReviewedExamplesPerSku)
      .sort((a, b) => a.groups - b.groups || a.count - b.count);
    const lowCoverageActions = [...actionCounts.entries()]
      .map(([action, count]) => ({
        action,
        count,
        groups: actionGroups.get(action)?.size ?? 0,
        minimum: run.minReviewedExamplesPerAction,
      }))
      .filter((entry) => entry.groups < run.minReviewedExamplesPerAction)
      .sort((a, b) => a.groups - b.groups || a.count - b.count);

    const imbalanceWarnings: string[] = [];
    const skuLabeledTotal = [...skuCounts.values()].reduce((a, b) => a + b, 0);
    const topSku = Math.max(0, ...skuCounts.values());
    if (skuCounts.size > 1 && topSku > skuLabeledTotal * 0.5) {
      imbalanceWarnings.push('SKU_IMBALANCE');
    }
    const actionLabeledTotal = [...actionCounts.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const topAction = Math.max(0, ...actionCounts.values());
    if (actionCounts.size > 1 && topAction > actionLabeledTotal * 0.5) {
      imbalanceWarnings.push('ACTION_IMBALANCE');
    }

    // Purpose-aware label check: READY must mean "ready FOR this task".
    const families = labelFamilies(eligible);
    const purposeCheck = purposeLabelCheck(run.purpose, families);
    imbalanceWarnings.push(...purposeCheck.warnings);

    // Durable small-dataset warning (not just a planner note).
    if (eligible.length > 0 && eligible.length < SMALL_DATASET_THRESHOLD) {
      imbalanceWarnings.push('SMALL_DATASET');
    }
    const lowGroupCoverage =
      [...skuGroups.entries()].some(
        ([sku, groups]) => (skuCounts.get(sku) ?? 0) >= 2 && groups.size === 1,
      ) ||
      [...actionGroups.entries()].some(
        ([action, groups]) =>
          (actionCounts.get(action) ?? 0) >= 2 && groups.size === 1,
      );
    if (lowGroupCoverage) {
      imbalanceWarnings.push('LOW_INDEPENDENT_GROUP_COVERAGE');
    }
    if (lowCoverageSkus.length || lowCoverageActions.length) {
      imbalanceWarnings.push('INSUFFICIENT_CLASS_GROUP_COVERAGE');
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

    // Requested-split completeness and per-class split coverage,
    // re-derived from the PERSISTED rows so the warnings are durable.
    let requestedSplitEmpty = false;
    let classMissingTrain = false;
    if (splitsPlanned) {
      const inSplit = (split: CvDatasetSplit) =>
        eligible.filter((row) => row.split === split).length;
      if (
        run.validationSplitPercent > 0 &&
        inSplit(CvDatasetSplit.VALIDATION) === 0
      ) {
        leakageWarnings.push('REQUESTED_VALIDATION_SPLIT_EMPTY');
        requestedSplitEmpty = true;
      }
      if (run.testSplitPercent > 0 && inSplit(CvDatasetSplit.TEST) === 0) {
        leakageWarnings.push('REQUESTED_TEST_SPLIT_EMPTY');
        requestedSplitEmpty = true;
      }
      const classMissing = (
        splitsByClass: Map<string, Set<string>>,
        groupsByClass: Map<string, Set<string>>,
      ) => {
        let missingTrain = false;
        let missingValidation = false;
        let missingTest = false;
        for (const [cls, splits] of splitsByClass) {
          if (!splits.has(CvDatasetSplit.TRAIN)) {
            missingTrain = true;
          }
          const groups = groupsByClass.get(cls)?.size ?? 0;
          if (groups >= 3) {
            if (
              run.validationSplitPercent > 0 &&
              !splits.has(CvDatasetSplit.VALIDATION)
            ) {
              missingValidation = true;
            }
            if (run.testSplitPercent > 0 && !splits.has(CvDatasetSplit.TEST)) {
              missingTest = true;
            }
          }
        }
        return { missingTrain, missingValidation, missingTest };
      };
      // Coverage gates are PURPOSE-SCOPED: only the class families the
      // run's task trains can block it (see purposeTrains*Classes).
      const noneMissing = {
        missingTrain: false,
        missingValidation: false,
        missingTest: false,
      };
      const sku = purposeTrainsSkuClasses(run.purpose)
        ? classMissing(skuSplits, skuGroups)
        : noneMissing;
      // Gate on the purpose's trainable action CLASSES (binary for
      // FALSE_TOUCH_FILTERING), never on every individual label.
      const action = purposeTrainsActionClasses(run.purpose)
        ? classMissing(gateActionSplits, gateActionGroups)
        : noneMissing;
      if (sku.missingTrain || action.missingTrain) {
        // The STABLE assignment left a trainable class with no TRAIN
        // examples. The plan is never silently overridden per run (that
        // would move the same group between splits across runs) — the
        // run is blocked instead.
        classMissingTrain = true;
        leakageWarnings.push('CLASS_MISSING_TRAIN_SPLIT');
        leakageWarnings.push('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
      }
      if (sku.missingValidation || action.missingValidation) {
        leakageWarnings.push('CLASS_MISSING_VALIDATION_SPLIT');
      }
      if (sku.missingTest || action.missingTest) {
        leakageWarnings.push('CLASS_MISSING_TEST_SPLIT');
      }
    }

    const readiness: DatasetReadiness =
      eligible.length === 0 ||
      !purposeCheck.satisfied ||
      requestedSplitEmpty ||
      classMissingTrain
        ? 'NOT_READY'
        : lowCoverageSkus.length ||
            lowCoverageActions.length ||
            imbalanceWarnings.length ||
            leakageWarnings.length
          ? 'WARNING'
          : 'READY';

    // Which cameras is this run's footage actually from? FILE_REPLAY
    // sources do not need calibration (Phase 17: NOT_APPLICABLE), so
    // calibration advice only applies when a live camera is involved.
    const sessionIds = [
      ...new Set(
        candidates
          .map((row) => row.liveSessionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const cameras = await this.sessionCameras(tenantId, sessionIds);
    const hasLiveCamera = [...cameras.values()].some(
      (camera) => camera.sourceType !== 'FILE_REPLAY',
    );

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
    if (!run.sourceCalibrationProfileId && hasLiveCamera) {
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
      requestedSplitEmpty,
      classMissingTrain,
      families,
      purposeSatisfied: purposeCheck.satisfied,
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

  /** Deterministic, STABLE split assignment: examples from the SAME
   *  live session share a hash group (leakage guard), and the group's
   *  sha256 bucket — keyed by tenant + group identity only, never the
   *  dataset run id or the run's composition — picks the split against
   *  the run's percentages. The assignment is NEVER overridden by
   *  current-run coverage rules: a group keeps the same split in every
   *  dataset run and every replan, so iterative comparisons stay valid
   *  and evaluation data never drifts into TRAIN. When the stable
   *  assignment leaves a trainable class without TRAIN examples, or a
   *  requested split empty, the run is WARNED and BLOCKED from export —
   *  not silently rearranged. HOLDOUT is never auto-assigned in the
   *  MVP. Only this run's candidate rows are updated —
   *  review/scenario/source records are never mutated. */
  async planSplits(tenantId: string, runId: string) {
    await this.requireRun(tenantId, runId);
    return this.withRunLock(tenantId, runId, async (tx) => {
      const run = await this.lockedRun(tx, tenantId, runId);
      if (
        run.status !== CvDatasetImprovementRunStatus.DRAFT &&
        run.status !== CvDatasetImprovementRunStatus.READY
      ) {
        throw new BadRequestException(
          `splits cannot be planned on a ${run.status} run`,
        );
      }
      const candidates = await tx.cvDatasetCandidate.findMany({
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

      // Class universes (confirmed SKU labels only) — used for the
      // WARN-ONLY class-coverage checks below, never to move a group.
      const skuCounts = new Map<string, number>();
      const actionCounts = new Map<string, number>();
      for (const row of eligible) {
        const confirmedSku = confirmedSkuOf(row);
        if (confirmedSku) {
          skuCounts.set(confirmedSku, (skuCounts.get(confirmedSku) ?? 0) + 1);
        }
        const action = effectiveAction(row);
        actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
      }

      // Same live session → same group → same split (leakage guard).
      const groups = new Map<string, CvDatasetCandidate[]>();
      for (const row of eligible) {
        const groupKey = groupKeyOf(row);
        const rows = groups.get(groupKey) ?? [];
        rows.push(row);
        groups.set(groupKey, rows);
      }

      const trainCeiling = run.trainSplitPercent * (SPLIT_BUCKET_SPACE / 100);
      const validationCeiling =
        (run.trainSplitPercent + run.validationSplitPercent) *
        (SPLIT_BUCKET_SPACE / 100);
      const warnings = new Set<string>();
      const splitByGroup = new Map<string, CvDatasetSplit>();

      // (a) base hash assignment — the key deliberately has NO run id,
      // so the same source group is stable across dataset runs (#7).
      for (const groupKey of groups.keys()) {
        const bucket = splitBucket(`${tenantId}:${groupKey}`);
        splitByGroup.set(
          groupKey,
          bucket < trainCeiling
            ? CvDatasetSplit.TRAIN
            : bucket < validationCeiling
              ? CvDatasetSplit.VALIDATION
              : CvDatasetSplit.TEST,
        );
      }

      // (b) class TRAIN coverage — WARN ONLY, never relocate: forcing a
      // group into TRAIN because THIS run's composition is small would
      // move the same group between splits across runs (split drift and
      // evaluation-data leakage). A class the stable hash left without
      // TRAIN examples blocks readiness/export instead.
      const groupKeysForClass = (
        matches: (row: CvDatasetCandidate) => boolean,
      ) => {
        const keys: string[] = [];
        for (const [groupKey, rows] of groups) {
          if (rows.some(matches)) {
            keys.push(groupKey);
          }
        }
        return keys;
      };
      const warnClassMissingTrain = (
        classes: string[],
        matches: (cls: string, row: CvDatasetCandidate) => boolean,
      ) => {
        for (const cls of [...classes].sort()) {
          const keys = groupKeysForClass((row) => matches(cls, row));
          if (
            keys.length &&
            !keys.some(
              (key) => splitByGroup.get(key) === CvDatasetSplit.TRAIN,
            )
          ) {
            warnings.add('CLASS_MISSING_TRAIN_SPLIT');
            warnings.add('INSUFFICIENT_STABLE_SPLIT_COVERAGE');
          }
        }
      };
      // Purpose-scoped (#P1): only the families the task trains can
      // warn/block — an irrelevant family hashing outside TRAIN must
      // not block an unrelated task. Assignment above is untouched.
      // Action gating runs over the purpose's trainable CLASSES: the
      // binary NO_OP-vs-positive-touch pair for FALSE_TOUCH_FILTERING,
      // the individual labels for every other purpose.
      const actionGateClasses = [
        ...new Set(
          [...actionCounts.keys()]
            .map((action) => actionGateClassOf(run.purpose, action))
            .filter((cls): cls is string => cls !== null),
        ),
      ];
      const actionGateMatch = (cls: string, row: CvDatasetCandidate) =>
        actionGateClassOf(run.purpose, effectiveAction(row)) === cls;
      if (purposeTrainsSkuClasses(run.purpose)) {
        warnClassMissingTrain(
          [...skuCounts.keys()],
          (cls, row) => confirmedSkuOf(row) === cls,
        );
      }
      if (purposeTrainsActionClasses(run.purpose)) {
        warnClassMissingTrain(actionGateClasses, actionGateMatch);
      }

      // (d) requested-split completeness (honesty about what the
      // percentages actually produced) and per-class evaluation-split
      // representation for classes with enough independent groups.
      const splitSummary = { TRAIN: 0, VALIDATION: 0, TEST: 0, HOLDOUT: 0 };
      for (const [groupKey, rows] of groups) {
        splitSummary[splitByGroup.get(groupKey)!] += rows.length;
      }
      const requestedNonzero = [
        run.trainSplitPercent,
        run.validationSplitPercent,
        run.testSplitPercent,
      ].filter((percent) => percent > 0).length;
      if (groups.size < requestedNonzero) {
        warnings.add('INSUFFICIENT_GROUPS_FOR_REQUESTED_SPLITS');
      }
      if (run.validationSplitPercent > 0 && splitSummary.VALIDATION === 0) {
        warnings.add('REQUESTED_VALIDATION_SPLIT_EMPTY');
      }
      if (run.testSplitPercent > 0 && splitSummary.TEST === 0) {
        warnings.add('REQUESTED_TEST_SPLIT_EMPTY');
      }
      const classSplitWarnings = (
        classes: string[],
        matches: (cls: string, row: CvDatasetCandidate) => boolean,
      ) => {
        for (const cls of classes) {
          const keys = groupKeysForClass((row) => matches(cls, row));
          if (keys.length < 3) {
            continue;
          }
          const splits = new Set(keys.map((key) => splitByGroup.get(key)));
          if (
            run.validationSplitPercent > 0 &&
            !splits.has(CvDatasetSplit.VALIDATION)
          ) {
            warnings.add('CLASS_MISSING_VALIDATION_SPLIT');
          }
          if (run.testSplitPercent > 0 && !splits.has(CvDatasetSplit.TEST)) {
            warnings.add('CLASS_MISSING_TEST_SPLIT');
          }
        }
      };
      if (purposeTrainsSkuClasses(run.purpose)) {
        classSplitWarnings(
          [...skuCounts.keys()],
          (cls, row) => confirmedSkuOf(row) === cls,
        );
      }
      if (purposeTrainsActionClasses(run.purpose)) {
        classSplitWarnings(actionGateClasses, actionGateMatch);
      }
      if (eligible.length < SMALL_DATASET_THRESHOLD) {
        warnings.add('SMALL_DATASET');
      }

      const idsBySplit = new Map<CvDatasetSplit, string[]>([
        [CvDatasetSplit.TRAIN, []],
        [CvDatasetSplit.VALIDATION, []],
        [CvDatasetSplit.TEST, []],
      ]);
      for (const [groupKey, rows] of groups) {
        idsBySplit
          .get(splitByGroup.get(groupKey)!)!
          .push(...rows.map((row) => row.id));
      }
      for (const [split, ids] of idsBySplit) {
        if (ids.length) {
          await tx.cvDatasetCandidate.updateMany({
            where: { tenantId, runId, id: { in: ids } },
            data: { split },
          });
        }
      }
      return {
        runId,
        splitSummary,
        groupCount: groups.size,
        warnings: [...warnings].sort(),
      };
    });
  }

  // ------------------------------------------------------------------
  // export manifest
  // ------------------------------------------------------------------

  /** Detects a candidate ledger that no longer matches the CURRENT
   *  source records (a newer review flipped a verdict, a scenario was
   *  re-recorded, a new eligible row appeared). The export must never
   *  ship obsolete labels. */
  private async assertCandidatesFresh(
    tenantId: string,
    run: CvDatasetImprovementRun,
    stored: CvDatasetCandidate[],
  ) {
    const seeds = await this.collectCandidates(tenantId, run);
    const keyOf = (row: { sourceType: string; sourceId: string }) =>
      `${row.sourceType}:${row.sourceId}`;
    const seedByKey = new Map(seeds.map((seed) => [keyOf(seed), seed]));
    const storedEligibleKeys = new Set(
      stored
        .filter((row) => row.eligibility === CvDatasetEligibility.ELIGIBLE)
        .map((row) => keyOf(row)),
    );
    let stale = false;
    for (const row of stored) {
      if (row.eligibility !== CvDatasetEligibility.ELIGIBLE) {
        continue;
      }
      const seed = seedByKey.get(keyOf(row));
      // Labels AND evidence lineage: a scenario re-recorded with the
      // same verdict against a different session, or a changed
      // evaluation/protocol/calibration stamp, is just as stale as a
      // flipped verdict — the manifest would point at the wrong
      // footage or assert setup metadata that was never used. The
      // operator-crop reference is part of that lineage (Codex P1): a
      // replacement crop reviewed after the refresh — including
      // null→crop, crop→different crop, and crop→null — must force a
      // refresh, or the export would name a crop the operator no
      // longer stands behind.
      if (
        !seed ||
        seed.eligibility !== CvDatasetEligibility.ELIGIBLE ||
        seed.skuId !== row.skuId ||
        seed.skuCodeSnapshot !== row.skuCodeSnapshot ||
        seed.actionLabel !== row.actionLabel ||
        seed.correctedActionLabel !== row.correctedActionLabel ||
        seed.reviewVerdict !== row.reviewVerdict ||
        seed.liveSessionId !== row.liveSessionId ||
        seed.evaluationRunId !== row.evaluationRunId ||
        seed.protocolId !== row.protocolId ||
        seed.calibrationProfileId !== row.calibrationProfileId ||
        seed.evidenceCropArtifactId !== row.evidenceCropArtifactId
      ) {
        stale = true;
        break;
      }
    }
    if (!stale) {
      for (const seed of seeds) {
        if (
          seed.eligibility === CvDatasetEligibility.ELIGIBLE &&
          !storedEligibleKeys.has(keyOf(seed))
        ) {
          stale = true;
          break;
        }
      }
    }
    if (stale) {
      throw new BadRequestException(
        `${DATASET_STALE_CANDIDATES}: source reviews, scenario results, or crop evidence changed after the last refresh — refresh candidates and re-plan splits before exporting`,
      );
    }
  }

  /** Calibration CONTENT freshness + the manifest's calibration
   *  section, from ONE read. The stored refresh-time fingerprint covers
   *  profile metadata AND zone membership (sorted ids, counts by type,
   *  updatedAt), so profile edits and zone additions, updates, and
   *  DELETIONS after the refresh all reject the export — including
   *  re-export of an EXPORTED run, whose frozen ledger keeps the
   *  original fingerprint. The returned snapshot is the SAME object the
   *  fingerprint validated, so the manifest can never carry different
   *  content than what passed validation. Applies only when the linked
   *  profile is stamped on eligible rows — FILE_REPLAY-only runs are
   *  never stamped and stay exempt (calibration is NOT_APPLICABLE). */
  private async validatedCalibrationSnapshot(
    db: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    run: CvDatasetImprovementRun,
    eligible: CvDatasetCandidate[],
  ): Promise<CalibrationSnapshot | null> {
    const profileId = run.sourceCalibrationProfileId;
    if (!profileId) {
      return null;
    }
    const stamped = eligible.some(
      (row) => row.calibrationProfileId === profileId,
    );
    if (!stamped) {
      return null;
    }
    const current = await this.readCalibrationSnapshot(db, tenantId, profileId);
    const storedFingerprint = run.calibrationFingerprint ?? null;
    if (
      !current ||
      storedFingerprint === null ||
      current.fingerprint !== storedFingerprint
    ) {
      // Controlled message — profile names, zone labels/ids, and camera
      // identifiers are never echoed.
      throw new BadRequestException(
        `${DATASET_STALE_CANDIDATES}: the linked calibration profile or its zones changed after the last refresh — refresh candidates and re-plan splits before exporting`,
      );
    }
    return current.snapshot;
  }

  /** Safe JSON manifest for OFFLINE training: references, labels, and
   *  controlled metadata only. The ENTIRE export — status check,
   *  candidate re-read, source re-validation, purpose-aware label
   *  check, split completeness, manifest construction, and the
   *  EXPORTED stamp — happens under the run lock, from ONE candidate
   *  snapshot. */
  async exportManifest(tenantId: string, runId: string) {
    await this.requireRun(tenantId, runId);
    return this.withRunLock(tenantId, runId, async (tx) => {
      const run = await this.lockedRun(tx, tenantId, runId);
      if (
        run.status !== CvDatasetImprovementRunStatus.READY &&
        run.status !== CvDatasetImprovementRunStatus.EXPORTED
      ) {
        throw new BadRequestException(
          `a ${run.status} run cannot be exported — mark it READY first`,
        );
      }
      const internals = await this.qualityInternals(tenantId, run, tx);
      if (internals.eligible.length === 0) {
        throw new BadRequestException(
          'no eligible candidates — refresh candidates first',
        );
      }
      if (!internals.splitsPlanned) {
        throw new BadRequestException(
          `${DATASET_EXPORT_REQUIRES_PLANNED_SPLITS}: plan splits before exporting`,
        );
      }
      await this.assertCandidatesFresh(tenantId, run, internals.candidates);
      // ONE calibration read: fingerprint validation and the manifest
      // section come from the same snapshot object (see helper doc).
      const calibration = await this.validatedCalibrationSnapshot(
        tx,
        tenantId,
        run,
        internals.eligible,
      );
      if (!internals.purposeSatisfied) {
        throw new BadRequestException(
          'export rejected: the run has no usable labels for its purpose — see the quality report',
        );
      }
      if (internals.requestedSplitEmpty) {
        throw new BadRequestException(
          'export rejected: a requested validation/test split is empty — re-plan splits or set its percentage to zero',
        );
      }
      if (internals.classMissingTrain) {
        throw new BadRequestException(
          'export rejected: a trainable class has no TRAIN examples under the stable split assignment (INSUFFICIENT_STABLE_SPLIT_COVERAGE) — collect more independent sessions or adjust the split percentages',
        );
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
      const skuSnapshots = new Map<
        string,
        { skuId: string | null; sku: string }
      >();
      for (const row of rows) {
        // The label list carries CONFIRMED SKU classes only — a
        // false-touch row's predicted SKU stays on its candidate as
        // reference metadata but is not a class label.
        const confirmedSku = confirmedSkuOf(row);
        if (confirmedSku) {
          skuSnapshots.set(`${row.skuId ?? ''}:${confirmedSku}`, {
            skuId: row.skuId,
            sku: confirmedSku,
          });
        }
      }
      const actionLabels = [...new Set(rows.map(effectiveAction))].sort();

      // The calibration section was captured above, in the SAME read
      // its fingerprint validation used — no re-read here, so a
      // concurrent profile/zone edit can only reject the export, never
      // slip changed metadata into the manifest.
      const warnings = [
        ...internals.imbalanceWarnings,
        ...internals.leakageWarnings,
        ...(internals.lowCoverageSkus.length ? ['LOW_COVERAGE_SKUS'] : []),
        ...(internals.lowCoverageActions.length
          ? ['LOW_COVERAGE_ACTIONS']
          : []),
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
      await tx.cvDatasetImprovementRun.updateMany({
        where: { tenantId, id: runId },
        data: {
          status: CvDatasetImprovementRunStatus.EXPORTED,
          exportedAt: generatedAt,
        },
      });
      return {
        runId,
        manifestVersion: 1,
        rowCount: rows.length,
        generatedAt,
        manifest,
      };
    });
  }

  // ------------------------------------------------------------------
  // model tuning report (advisory only)
  // ------------------------------------------------------------------

  /** ADVISORY ONLY: no training is invoked, no external model API is
   *  called, and no accuracy projection is ever produced. The
   *  recommended task never names a task the dataset has zero usable
   *  labels for. */
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
    const mappedTask = taskByPurpose[run.purpose];
    let recommendedModelTask = mappedTask;
    let noUsableTask = false;
    if (!taskUsable(mappedTask, internals.families)) {
      const fallback = [
        'SKU_CLASSIFICATION',
        'ACTION_RECOGNITION',
        'FALSE_TOUCH_FILTERING',
      ].find((task) => taskUsable(task, internals.families));
      if (fallback) {
        recommendedModelTask = fallback;
      } else {
        recommendedModelTask = 'MIXED';
        noUsableTask = !taskUsable('MIXED', internals.families);
      }
    }
    const tuningReadiness: DatasetReadiness =
      internals.readiness === 'NOT_READY' ||
      !internals.splitsPlanned ||
      noUsableTask
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
      recommendedModelTask,
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
      // Durable dataset warnings restated here so the tuning surface
      // can never look healthier than the dataset it describes.
      warnings: [
        ...internals.imbalanceWarnings,
        ...internals.leakageWarnings,
      ],
      advisory: DATASET_TUNING_ADVISORY,
      safety: SAFETY,
    };
  }
}
