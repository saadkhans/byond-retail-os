import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyEventType,
  FusionPolicyResult,
  FusionRunScope,
  GroundTruthEventKind,
  InferenceJobStatus,
  PilotExpectedAction,
  PilotObservationVerdict,
} from '@prisma/client';
import { oneSkuBootstrapImportAdvisoryLockKey } from '../common/locks';
import { JourneyService } from '../journey/journey.service';
import { PilotEvaluationService } from '../pilot-evaluation/pilot-evaluation.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { pickupSourceId } from '../pickup-detection/pickup-detection.service';
import { PICKUP_MIN_REFERENCE_IMAGES } from '../pickup-detection/reference-images.service';
import { EMBEDDING_MODEL_KEY, EMBEDDING_MODEL_VERSION } from '../pickup-fusion/primitives';
import { PrismaService } from '../prisma/prisma.service';
import {
  BOOTSTRAP_MAX_CLIPS,
  BootstrapFailureReason,
  GateItem,
  RECOMMENDED_REFERENCE_IMAGES,
  SCORE_NOTE,
  SafeFusionSummary,
  applyOperatorCrop,
  deriveFailureReasons,
  evaluateGates,
  fusionFrameDimsFor,
  isPhase18EligibleReview,
  matchesCurrentGroundTruth,
  predictedActionOfEventType,
  safeFusionSummary,
} from './one-sku-bootstrap.report';

/**
 * One-SKU bootstrap — guides an operator through proving out a single
 * SKU (references → embeddings → inventory → clean test clips → reviewed
 * examples) before scaling to 5+ SKUs.
 *
 * WRITE DISCIPLINE (pinned by shadow-mode.spec.ts): this module performs
 * NO raw Prisma write. The two mutating flows DELEGATE to the existing
 * shadow services and inherit their guarantees:
 * - PilotEvaluationService (append-only pilot reviews — the Phase 18
 *   candidate source), and
 * - JourneyService (shadow journeys/events only; its own guard pins that
 *   it never touches checkout, order, payment, or inventory tables).
 * Corrections NEVER go through the vision-event review endpoint, whose
 * APPROVE/OVERRIDE path can mutate checkout-session basket lines —
 * session-bound clips are flagged and excluded outright.
 *
 * READINESS DISCIPLINE (Codex P1): a clip counts as reviewed ONLY when
 * the LINKED bootstrap evaluation run holds a review that (a) is bound
 * to the clip's LATEST fusion run's imported event and (b) mirrors
 * Phase 18's candidate-eligibility rules — the gates and the Phase 18
 * candidate refresh must agree about the same evidence.
 *
 * Response safety: only ids, SKUs, sanitized filenames, classified codes,
 * and numbers leave this service — never storage keys, OCR/barcode text,
 * or provider error text (see safeFusionSummary's allowlist).
 */

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/** Deterministic per-SKU evaluation-run name (display). The find-or-create
 *  IDENTITY is the structured PilotEvaluationRun.bootstrapProductId field;
 *  names only classify legacy runs created before that field existed.
 *  Successor runs (created when the previous one went terminal) carry a
 *  " (n)" suffix. */
export function bootstrapRunName(sku: string): string {
  return `One SKU bootstrap — ${sku}`;
}

/** Does `name` belong to THIS SKU's bootstrap-run family? Exact match
 *  or a " (n)" successor — a bare startsWith would also match a LONGER
 *  SKU whose code has this SKU as a prefix. */
export function isBootstrapRunNameFor(name: string, sku: string): boolean {
  const base = bootstrapRunName(sku);
  if (name === base) {
    return true;
  }
  if (!name.startsWith(`${base} `)) {
    return false;
  }
  return /^\(\d+\)$/.test(name.slice(base.length + 1));
}

/** Verdicts a bootstrap correction may record. MISSED_EVENT is excluded
 *  (it requires an attached live session, which video clips never have);
 *  missed positives stay visible in this report until corrected. */
export const BOOTSTRAP_REVIEW_VERDICTS = [
  PilotObservationVerdict.CORRECT,
  PilotObservationVerdict.WRONG_SKU,
  PilotObservationVerdict.WRONG_ACTION,
  PilotObservationVerdict.FALSE_TOUCH,
  PilotObservationVerdict.UNCERTAIN,
] as const;

export type BootstrapExclusionReason =
  | 'SESSION_BOUND'
  | 'MISSING_STORE_CONTEXT';

export interface BootstrapVideoRow {
  videoAssetId: string;
  originalFilename: string;
  assetStatus: string;
  durationMs: number | null;
  eventKind: GroundTruthEventKind;
  testType: string | null;
  expectedSku: string | null;
  quantity: number;
  actualTimestampMs: number | null;
  /** Signed provisional-basket change the clip SHOULD produce
   *  (+quantity pickup, -quantity return, 0 false touch). Display only —
   *  no basket, order, or inventory row is ever written from CV. */
  expectedBasketDelta: number;
  /** Set when the clip is EXCLUDED from bootstrap review/readiness:
   *  SESSION_BOUND (checkout-session path — correction could mutate a
   *  basket) or MISSING_STORE_CONTEXT (no shadow journey possible).
   *  Excluded rows never count toward any gate. */
  excludedReason: BootstrapExclusionReason | null;
  /** PICKUP/RETURN ground truth whose succeeded analysis produced NO
   *  event — needs a human missed-event correction, never auto-reviewed. */
  missedPositiveEvent: boolean;
  reviewed: boolean;
  /** A review exists only for an OLDER fusion run of this clip — the
   *  newest evidence needs a fresh review. */
  staleReview: boolean;
  /** An eligible-shaped review exists on the LATEST evidence, but its
   *  EFFECTIVE labels contradict the clip's CURRENT (edited) ground
   *  truth — stale, re-review required (Codex P1). */
  staleTruthReview: boolean;
  reviewDecision: string | null;
  /** Latest bootstrap pilot-review verdict bound to the clip's LATEST
   *  fusion run (the linked evaluation run only), if any. */
  bootstrapReviewVerdict: string | null;
  /** Whether that review mirrors a Phase 18 ELIGIBLE candidate. */
  bootstrapReviewEligible: boolean;
  visionEventStatus: string | null;
  needsReview: boolean;
  predictedSku: string | null;
  /** null until a fusion run exists for the clip. */
  predictionMatchesExpected: boolean | null;
  fusion: SafeFusionSummary | null;
}

export interface OneSkuBootstrapReport {
  product: { id: string; sku: string; name: string; status: string };
  references: {
    referenceCount: number;
    minRequired: number;
    recommended: number;
    inferenceReady: boolean;
    embeddingCount: number;
    embeddingModelKey: string;
    embeddingModelVersion: string;
    embeddingsBuilt: boolean;
  };
  inventory: {
    /** Non-sensitive readiness classification — safe for vision-only
     *  callers. */
    stocked: boolean;
    /** true only when the caller holds inventory:read AND the tenant has
     *  the inventory module enabled (Codex P1): exact quantities and
     *  location details below mirror the inventory API's own access
     *  boundary and are redacted (null / empty) otherwise. */
    detailsVisible: boolean;
    totalOnHand: number | null;
    levels: {
      locationId: string;
      locationName: string;
      locationCode: string;
      quantity: number;
    }[];
  };
  /** true only when the caller clears the video-asset read boundary
   *  (video-ingest module + video-asset:read): the per-clip rows below
   *  carry filenames, states, durations, timestamps, crop geometry, and
   *  artifact ids — the same metadata the video-asset routes protect.
   *  When false, `videos` is empty and only aggregate readiness remains. */
  videoDetailsVisible: boolean;
  /** Newest BOOTSTRAP_MAX_CLIPS rows for display — counts and gates are
   *  computed over the COMPLETE ground-truth set, not this slice.
   *  Empty whenever videoDetailsVisible is false. */
  videos: BootstrapVideoRow[];
  counts: {
    /** Bootstrap-safe clips only — excluded rows are not counted. */
    totalClips: number;
    excludedClips: number;
    reviewedPickupExamples: number;
    reviewedReturnExamples: number;
    /** NONE ground truth carries no SKU, so false-touch examples are
     *  counted tenant-wide by design. */
    reviewedFalseTouchExamples: number;
    unreviewedClips: number;
  };
  /** The Phase 18 candidate source this bootstrap feeds. */
  linkedEvaluationRun: {
    evaluationRunId: string;
    name: string;
    status: string;
    reviewCount: number;
  } | null;
  /** Latest FUSION evidence summary — video-derived, so null whenever
   *  videoDetailsVisible is false. */
  latest: {
    predictedSku: string | null;
    topScore: number | null;
    policy: string;
    vlmVerdict: string | null;
    vlmStatus: string | null;
    runCreatedAt: Date;
  } | null;
  /** Derived from fusion/crop/VLM evidence — empty whenever
   *  videoDetailsVisible is false. */
  failureReasons: { reason: BootstrapFailureReason; count: number }[];
  gates: { items: GateItem[]; readyForDatasetImprovement: boolean };
  scoreNote: string;
}

@Injectable()
export class OneSkuBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluations: PilotEvaluationService,
    private readonly journeys: JourneyService,
    // READ-ONLY: module-enablement lookup for the inventory redaction
    // (isEnabledForTenant only — never enable/disable).
    private readonly platformModules: PlatformModulesService,
  ) {}

  private async requireProduct(tenantId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true, sku: true, name: true, status: true },
    });
    if (!product) {
      throw new NotFoundException('product not found');
    }
    return product;
  }

  /** This product's bootstrap-run family, newest first: runs stamped
   *  with the STRUCTURED bootstrapProductId identity, plus legacy rows
   *  (created before that field existed) matched by exact run-name
   *  family. Deliberately UN-limited (Codex P2): a `take` on a broad
   *  prefix scan could truncate away the real open run behind other
   *  SKUs' prefix-colliding names — the exact filters below run over
   *  EVERY fetched row, and both ensureEvaluationRun and report resolve
   *  the active run through this one method. */
  private async bootstrapRunFamily(
    tenantId: string,
    productId: string,
    sku: string,
  ) {
    const rows = await this.prisma.pilotEvaluationRun.findMany({
      where: {
        tenantId,
        OR: [
          { bootstrapProductId: productId },
          {
            bootstrapProductId: null,
            name: { startsWith: bootstrapRunName(sku) },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        status: true,
        bootstrapProductId: true,
        _count: { select: { reviews: true } },
      },
    });
    return rows.filter(
      (row) =>
        row.bootstrapProductId === productId ||
        (row.bootstrapProductId === null &&
          isBootstrapRunNameFor(row.name, sku)),
    );
  }

  /**
   * Find-or-create the per-SKU bootstrap evaluation run (Phase 15) —
   * the ONLY source Phase 18 candidate refresh can read reviews from.
   * Only an OPEN run is ever reused (Codex P2): reviews are append-only
   * on OPEN runs, so a COMPLETED/CANCELLED run is terminal history and
   * a new suffixed successor is opened instead of writing to it.
   *
   * Concurrency (Codex P2): creation stamps the STRUCTURED
   * bootstrapProductId identity, and a partial unique index allows at
   * most one OPEN bootstrap run per tenant/product — when two first
   * corrections race, the loser's create hits the index (P2002) and
   * re-reads the winner's run, so reviews can never split across
   * duplicate open runs.
   */
  async ensureEvaluationRun(
    tenantId: string,
    productId: string,
    actorId?: string,
  ): Promise<{
    evaluationRunId: string;
    name: string;
    status: string;
    created: boolean;
  }> {
    const product = await this.requireProduct(tenantId, productId);
    const family = await this.bootstrapRunFamily(
      tenantId,
      product.id,
      product.sku,
    );
    const open = family.find((run) => run.status === 'OPEN');
    if (open) {
      return {
        evaluationRunId: open.id,
        name: open.name,
        status: open.status,
        created: false,
      };
    }
    const base = bootstrapRunName(product.sku);
    const name =
      family.length === 0 ? base : `${base} (${family.length + 1})`;
    try {
      const created = await this.evaluations.createRun(
        tenantId,
        {
          name,
          description:
            `Auto-created by the one-SKU bootstrap workflow for ${product.sku}. ` +
            'Holds reviewed/corrected bootstrap clip evidence for Phase 18 ' +
            'dataset improvement.',
          bootstrapProductId: product.id,
        },
        actorId,
      );
      return {
        evaluationRunId: created.evaluationRunId,
        name: created.name,
        status: created.status,
        created: true,
      };
    } catch (error) {
      if (prismaErrorCode(error) !== 'P2002') {
        throw error;
      }
      // Lost the create race: another request opened this product's
      // bootstrap run between our lookup and create — reuse it.
      const retried = await this.bootstrapRunFamily(
        tenantId,
        product.id,
        product.sku,
      );
      const winner = retried.find((run) => run.status === 'OPEN');
      if (!winner) {
        throw error;
      }
      return {
        evaluationRunId: winner.id,
        name: winner.name,
        status: winner.status,
        created: false,
      };
    }
  }

  /**
   * Record ONE bootstrap correction as Phase 18-compatible evidence:
   * import the clip's latest whole-clip fusion run as a FUSION_SHADOW
   * journey event (JourneyService — shadow tables only) and append a
   * pilot review against it (PilotEvaluationService — append-only).
   * This path can NEVER touch a checkout basket: session-bound clips
   * are refused outright, and neither delegated service writes checkout,
   * order, payment, or inventory rows.
   *
   * Verdict validation mirrors Phase 18 eligibility (Codex P1): CORRECT
   * only when the imported event matches the ground truth in BOTH sku
   * and action; WRONG_SKU/WRONG_ACTION must actually change something.
   * A newer operator crop is bound into the review notes as the
   * evidence override marker.
   */
  async reviewClip(
    tenantId: string,
    productId: string,
    videoAssetId: string,
    input: {
      verdict: PilotObservationVerdict;
      expectedAction: PilotExpectedAction;
      expectedProductId?: string | null;
      notes?: string | null;
    },
    actorId?: string,
  ): Promise<{
    evaluationRunId: string;
    journeyEventId: string;
    reviewId: string;
    verdict: PilotObservationVerdict;
  }> {
    if (
      !(BOOTSTRAP_REVIEW_VERDICTS as readonly PilotObservationVerdict[]).includes(
        input.verdict,
      )
    ) {
      throw new BadRequestException(
        'bootstrap corrections accept CORRECT, WRONG_SKU, WRONG_ACTION, ' +
          'FALSE_TOUCH, or UNCERTAIN',
      );
    }
    await this.requireProduct(tenantId, productId);
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: { id: true, locationId: true, unitId: true, sessionId: true },
    });
    if (!asset) {
      throw new NotFoundException('video asset not found');
    }
    if (asset.sessionId !== null) {
      throw new ConflictException(
        'this clip is bound to a checkout session and is excluded from ' +
          'bootstrap corrections — record-only evidence must never reach ' +
          'a basket',
      );
    }
    if (!asset.locationId) {
      throw new BadRequestException(
        'the clip has no store context — re-upload it with a store so its ' +
          'shadow journey can be opened in the same store',
      );
    }
    // Captured after the guard: the narrowing does not survive into the
    // import transaction's closure below.
    const storeContext = { locationId: asset.locationId, unitId: asset.unitId };
    const truth = await this.prisma.videoGroundTruth.findFirst({
      where: { tenantId, videoAssetId },
      select: { eventKind: true, productId: true },
    });
    if (!truth) {
      throw new ConflictException(
        'set the clip’s ground truth first — corrections label the ' +
          'prediction against it',
      );
    }
    // Bind the clip to the ROUTE product (Codex P1): a positive
    // (PICKUP/RETURN) clip ground-truthed for a DIFFERENT product must
    // never enter this product's bootstrap run — Phase 18 would collect
    // it as this product's evidence while this product's report never
    // displays it. Rejected BEFORE any run/journey/review is created or
    // reused. NONE (false-touch) clips carry no product by design and
    // stay tenant-wide.
    if (
      truth.eventKind !== GroundTruthEventKind.NONE &&
      truth.productId !== productId
    ) {
      throw new ConflictException(
        'this clip’s ground truth belongs to a different product — ' +
          'record the correction from THAT product’s bootstrap page so ' +
          'the evidence lands in the right evaluation run',
      );
    }
    // Correction product lineage (Codex P1): a corrected product must be
    // the clip's OWN ground-truth product. The route check above pins
    // truth.productId === productId for positive clips, so ANY other
    // corrected product — a third SKU, or any product on a NONE clip
    // (which carries none) — would flow into Phase 18 as the corrected
    // label while the report counts the clip toward THIS product's
    // readiness from its ground truth: dataset-ready on mislabeled data.
    // Rejected BEFORE any run/journey/review is created or reused.
    if (
      input.expectedProductId &&
      input.expectedProductId !== truth.productId
    ) {
      throw new BadRequestException(
        'the corrected product must be the clip’s ground-truth product — ' +
          'if the clip really shows a different product, fix its ground ' +
          'truth first',
      );
    }
    // WRONG_SKU without the correction would only fail AFTER the run and
    // event exist — reject it up front so nothing is created (Phase 18
    // would exclude it as MISSING_CORRECTED_SKU anyway).
    if (
      input.verdict === PilotObservationVerdict.WRONG_SKU &&
      !input.expectedProductId
    ) {
      throw new BadRequestException(
        'WRONG_SKU needs the corrected product — Phase 18 would exclude ' +
          'this as MISSING_CORRECTED_SKU',
      );
    }
    // False-touch requires NONE ground truth (Codex P1): FALSE_TOUCH on
    // a PICKUP/RETURN clip would hand Phase 18 an eligible NO_OP
    // candidate that contradicts the clip's own ground truth — and count
    // toward the false-touch minimum. Rejected BEFORE anything exists.
    if (
      input.verdict === PilotObservationVerdict.FALSE_TOUCH &&
      truth.eventKind !== GroundTruthEventKind.NONE
    ) {
      throw new BadRequestException(
        'FALSE_TOUCH is only valid for a clip ground-truthed as NONE — ' +
          'if nothing was really removed in this clip, fix its ground ' +
          'truth first',
      );
    }
    // Corrected-action lineage (Codex P1): every dataset-bound verdict
    // must carry the CURRENT ground truth's action. WRONG_ACTION restores
    // the truth's action over a wrong prediction — it never invents a
    // third label (predicted PICKUP on a RETURN clip corrects to RETURN,
    // NOT to NO_OP). UNCERTAIN is exempt: Phase 18 excludes it anyway.
    const truthAction =
      truth.eventKind === GroundTruthEventKind.NONE
        ? PilotExpectedAction.NO_OP
        : truth.eventKind === GroundTruthEventKind.RETURN
          ? PilotExpectedAction.RETURN
          : PilotExpectedAction.PICKUP;
    if (
      input.verdict !== PilotObservationVerdict.UNCERTAIN &&
      input.expectedAction !== truthAction
    ) {
      throw new BadRequestException(
        'the corrected action must be the clip’s ground-truth action — ' +
          'if the clip really shows a different action, fix its ground ' +
          'truth first',
      );
    }
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: {
        tenantId,
        videoAssetId,
        runScope: FusionRunScope.WHOLE_CLIP,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true, policy: true, fusedTopSku: true },
    });
    if (!run) {
      throw new ConflictException(
        'run fusion on this clip first — the correction labels its fusion evidence',
      );
    }
    // A FAILED run is NOT completed analysis — nothing can be labeled
    // from it (importing it would only mint unreviewable shadow noise,
    // and every retry would open another journey). Refuse up front,
    // idempotently, before any run/journey/review exists.
    if (run.policy === FusionPolicyResult.FAILED) {
      throw new ConflictException(
        'the latest fusion run FAILED — re-run fusion on this clip ' +
          'before reviewing it',
      );
    }
    // Completed with NO fused candidate: the one reviewable statement is
    // a NONE clip's FALSE_TOUCH — a TRUE NEGATIVE where the pipeline
    // correctly proposed nothing (Codex P1: five such clips must be able
    // to satisfy the NO_OP gate without waiting for false positives).
    // The FALSE_TOUCH↔NONE pairing was already validated above; every
    // other verdict has no candidate to label.
    const runProposes = run.fusedTopSku !== null;
    if (
      !runProposes &&
      input.verdict !== PilotObservationVerdict.FALSE_TOUCH
    ) {
      throw new ConflictException(
        'fusion produced no candidate for this clip — there is nothing ' +
          'to label; improve references or recapture the clip',
      );
    }
    const evaluation = await this.ensureEvaluationRun(
      tenantId,
      productId,
      actorId,
    );

    // A PROPOSING run's import is a product event; a completed
    // NO-PROPOSAL run's import is the REVIEW_REQUIRED event — the
    // structured no-candidate record a FALSE_TOUCH true-negative review
    // binds to. The type sets are kept DISJOINT per case so an
    // elsewhere-created REVIEW_REQUIRED can never shadow a proposing
    // run's product event, and retries of a no-proposal import find the
    // existing REVIEW_REQUIRED row instead of opening another journey.
    const importedEventTypes = runProposes
      ? [
          CustomerJourneyEventType.PRODUCT_PICKUP,
          CustomerJourneyEventType.PRODUCT_RETURN,
        ]
      : [CustomerJourneyEventType.REVIEW_REQUIRED];
    const findImportedEvent = () =>
      this.prisma.customerJourneyEvent.findFirst({
        where: {
          tenantId,
          videoAssetId,
          fusionRunId: run.id,
          sourceType: 'FUSION_SHADOW',
          eventType: { in: importedEventTypes },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, productId: true, sku: true, eventType: true },
      });

    let event = await findImportedEvent();
    if (!event) {
      // Serialize the per-clip import (Codex P2): two operators
      // submitting the FIRST review for the same clip concurrently would
      // both see no imported event and each open a journey + append a
      // FUSION_SHADOW event for the same fusion run — Phase 18 would
      // collect the footage twice under different source events (each
      // bootstrap import opens its OWN journey, so appendEvent's
      // journey-scoped dedup cannot see the race). The advisory xact
      // lock makes check-then-import a critical section: the loser
      // blocks here, re-reads, and reuses the winner's event. The
      // delegated journey writes commit in their own transactions before
      // the lock releases, so the loser's re-read always sees them.
      event = await this.prisma.$transaction(async (tx) => {
        // ::text cast is load-bearing (see common/locks.ts).
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${oneSkuBootstrapImportAdvisoryLockKey(
          tenantId,
          videoAssetId,
        )}))::text`;
        const imported = await findImportedEvent();
        if (imported) {
          return imported;
        }
        const journey = await this.journeys.create(
          tenantId,
          storeContext,
          actorId,
        );
        await this.journeys.appendFromFusionRun(
          tenantId,
          journey.id,
          videoAssetId,
          actorId,
          // Bootstrap imports label the pipeline's TOP candidate even
          // when the policy demoted the run to review — correcting
          // exactly those low-confidence clips is the point of the
          // bootstrap.
          { fusionRunId: run.id, proposeBelowThreshold: true },
        );
        return findImportedEvent();
      });
      if (!event) {
        throw new ConflictException(
          'fusion produced no candidate for this clip — there is nothing ' +
            'to label; improve references or recapture the clip',
        );
      }
    }

    // Verdict/ground-truth consistency (Codex P1): CORRECT must mean the
    // prediction matches ground truth in BOTH sku and action — Phase 18
    // keeps the event's predicted action for CORRECT, so confirming a
    // wrong-action prediction would mislabel the candidate.
    const predictedAction = predictedActionOfEventType(event.eventType);
    if (input.verdict === PilotObservationVerdict.CORRECT) {
      if (truth.eventKind === GroundTruthEventKind.NONE) {
        throw new BadRequestException(
          'the ground truth says nothing was removed — record FALSE_TOUCH, ' +
            'not CORRECT',
        );
      }
      if (event.productId !== truth.productId) {
        throw new BadRequestException(
          'the predicted product differs from the ground truth — record ' +
            'WRONG_SKU with the corrected product',
        );
      }
      if (predictedAction !== truth.eventKind) {
        throw new BadRequestException(
          'the predicted action differs from the ground truth — record ' +
            'WRONG_ACTION with the corrected action',
        );
      }
    }
    if (input.verdict === PilotObservationVerdict.WRONG_ACTION) {
      // expectedAction equals the ground-truth action (validated BEFORE
      // the import above) — here only the prediction comparison remains.
      if (input.expectedAction === predictedAction) {
        throw new BadRequestException(
          'the corrected action equals the predicted action — Phase 18 ' +
            'would exclude this as CORRECTION_NOT_DIFFERENT',
        );
      }
      // Both-wrong (Codex P1): WRONG_ACTION with expectedProductId
      // corrects BOTH labels in Phase 18 — when the predicted product
      // also differs from ground truth, the corrected product is
      // mandatory or the candidate would keep the known-wrong SKU.
      if (
        truth.eventKind !== GroundTruthEventKind.NONE &&
        event.productId !== truth.productId &&
        !input.expectedProductId
      ) {
        throw new BadRequestException(
          'the predicted product also differs from the ground truth — ' +
            'include the corrected product so both labels are fixed',
        );
      }
    }
    if (input.verdict === PilotObservationVerdict.WRONG_SKU) {
      // expectedProductId presence + ground-truth lineage were both
      // validated BEFORE the import above.
      if (input.expectedProductId === event.productId) {
        throw new BadRequestException(
          'the corrected product equals the predicted product — Phase 18 ' +
            'would exclude this as CORRECTION_NOT_DIFFERENT',
        );
      }
      // Both-wrong must NOT be persisted as WRONG_SKU (Codex P1):
      // Phase 18's WRONG_SKU path leaves correctedActionLabel null, so
      // the candidate would keep the detector's known-wrong action.
      if (
        truth.eventKind !== GroundTruthEventKind.NONE &&
        predictedAction !== truth.eventKind
      ) {
        throw new BadRequestException(
          'the predicted action also differs from the ground truth — ' +
            'record WRONG_ACTION with the corrected action AND the ' +
            'corrected product so both labels are fixed',
        );
      }
    }

    // Operator crop override (Codex P1): a manual crop newer than the
    // reviewed fusion run is bound into the review record as STRUCTURED
    // data (PilotObservationReview.operatorCropArtifactId — an OPAQUE
    // artifact id, never a path, never free-form notes). Phase 18
    // candidate refresh copies it into evidenceCropArtifactId so the
    // export names the crop the operator actually approved.
    const operatorCrop = await this.prisma.videoArtifact.findFirst({
      where: {
        tenantId,
        videoAssetId,
        artifactType: 'CROP',
        createdById: { not: null },
        createdAt: { gt: run.createdAt },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    const review = await this.evaluations.reviewObservation(
      tenantId,
      evaluation.evaluationRunId,
      {
        verdict: input.verdict,
        expectedAction: input.expectedAction,
        journeyEventId: event.id,
        expectedProductId: input.expectedProductId ?? null,
        operatorCropArtifactId: operatorCrop?.id ?? null,
        notes: input.notes ?? null,
      },
      actorId,
      // The bootstrap flow validated the SKU, the linked bootstrap run,
      // the asset, and its LATEST fusion run above — the only path
      // allowed to label a video-shadow observation.
      { allowVideoShadowEvent: true },
    );
    return {
      evaluationRunId: evaluation.evaluationRunId,
      journeyEventId: event.id,
      reviewId: review.reviewId,
      verdict: review.verdict,
    };
  }

  async report(
    tenantId: string,
    productId: string,
    // Fail-closed defaults (Codex P1): detailed stock/location data and
    // video-derived clip metadata are shown only when the CALLER's
    // access is affirmatively established — an omitted viewer or an
    // omitted field means redacted.
    viewer: {
      hasInventoryReadPermission?: boolean;
      hasVideoAssetReadPermission?: boolean;
    } = {},
  ): Promise<OneSkuBootstrapReport> {
    const product = await this.requireProduct(tenantId, productId);

    // Detailed stock rows mirror the inventory API's own boundary:
    // inventory module enabled for the tenant AND inventory:read on the
    // caller. Readiness (stocked yes/no, the INVENTORY_STOCKED gate) is
    // still computed server-side for everyone — hiding details must not
    // block the bootstrap flow.
    const inventoryDetailsVisible =
      viewer.hasInventoryReadPermission === true &&
      (await this.platformModules.isEnabledForTenant(tenantId, 'inventory'));
    // Per-clip rows mirror the video-asset read boundary (Codex P1):
    // filenames, asset states, durations, ground-truth timestamps, crop
    // geometry, and artifact ids are exactly what the video-asset routes
    // protect behind the video-ingest module + video-asset:read — this
    // report must not become a side door. Counts and gates stay computed
    // server-side for everyone (numbers and classified codes only).
    const videoDetailsVisible =
      viewer.hasVideoAssetReadPermission === true &&
      (await this.platformModules.isEnabledForTenant(tenantId, 'video-ingest'));
    // The bootstrap report is video-derived END TO END — clip rows,
    // fusion summaries, crop gates, failure rollups, and even the clip
    // COUNTS all describe video evidence. Field-level redaction kept
    // regrowing leak surface (Codex P1, three rounds), so the whole
    // route now requires the video-asset read boundary — the documented
    // fallback ("require video-ingest + video-asset:read for the entire
    // report route"). The per-field redaction below stays as defense in
    // depth should this gate ever soften.
    if (!videoDetailsVisible) {
      throw new ForbiddenException(
        'the one-SKU bootstrap report requires the video-ingest module ' +
          'and video-asset:read — its readiness evidence is video-derived',
      );
    }

    const [referenceCount, embeddingCount, levels, stockAggregate, runFamily] =
      await Promise.all([
        this.prisma.productReferenceImage.count({
          where: { tenantId, productId },
        }),
        this.prisma.productReferenceEmbedding.count({
          where: { tenantId, productId, modelKey: EMBEDDING_MODEL_KEY },
        }),
        // DISPLAY rows only — bounded for response size. Readiness and
        // the tenant-wide total come from the un-limited aggregate below
        // (Codex P2): stock parked beyond the 50th location must still
        // count, or "not stocked" would be reported over real inventory.
        this.prisma.inventoryLevel.findMany({
          where: { tenantId, productId },
          select: {
            locationId: true,
            quantity: true,
            location: { select: { name: true, code: true } },
          },
          take: 50,
        }),
        this.prisma.inventoryLevel.aggregate({
          where: { tenantId, productId },
          _sum: { quantity: true },
        }),
        this.bootstrapRunFamily(tenantId, product.id, product.sku),
      ]);
    // Only an OPEN run is the ACTIVE linked run (Codex P2): a
    // COMPLETED/CANCELLED run is terminal history — new corrections go
    // to a successor, so readiness must not lean on a run that can no
    // longer accept reviews.
    const linkedRun = runFamily.find((run) => run.status === 'OPEN') ?? null;

    // This SKU's PICKUP/RETURN clips plus every NONE (false-touch) clip:
    // NONE ground truth force-nulls productId, so negatives are shared.
    // Deliberately UN-limited (Codex P2): counts and gates must read the
    // COMPLETE set — a display cap here would let ALL_REVIEWED pass over
    // omitted older unreviewed clips, and recent tenant-wide negatives
    // would displace this SKU's positive examples. Only the RESPONSE's
    // video list is bounded (newest BOOTSTRAP_MAX_CLIPS rows, below).
    const truths = await this.prisma.videoGroundTruth.findMany({
      where: {
        tenantId,
        OR: [{ productId }, { eventKind: GroundTruthEventKind.NONE }],
        videoAsset: { deletedAt: null },
      },
      include: {
        product: { select: { sku: true } },
        videoAsset: {
          select: {
            originalFilename: true,
            status: true,
            durationMs: true,
            width: true,
            height: true,
            locationId: true,
            sessionId: true,
            deletedAt: true,
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    const liveTruths = truths.filter(
      (truth) => truth.videoAsset.deletedAt === null,
    );
    const assetIds = liveTruths.map((truth) => truth.videoAssetId);

    const [runs, jobs, operatorCrops] = await Promise.all([
      assetIds.length === 0
        ? Promise.resolve([])
        : this.prisma.pickupFusionRun.findMany({
            // WHOLE_CLIP only — same rule as cv-evaluation: replay-window
            // runs of the same video must not displace whole-clip results.
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              runScope: FusionRunScope.WHOLE_CLIP,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              videoAssetId: true,
              createdAt: true,
              policy: true,
              evidence: true,
            },
          }),
      assetIds.length === 0
        ? Promise.resolve([])
        : this.prisma.inferenceJob.findMany({
            where: {
              tenantId,
              sourceId: { in: assetIds.map((id) => pickupSourceId(id)) },
            },
            orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
            select: {
              sourceId: true,
              status: true,
              visionEventId: true,
            },
          }),
      // Manual crops (Codex P1): an operator-created crop — createdById
      // is set ONLY on the HTTP path; every pipeline crop call site omits
      // the actor — supersedes the auto crop as this clip's evidence.
      assetIds.length === 0
        ? Promise.resolve([])
        : this.prisma.videoArtifact.findMany({
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              artifactType: 'CROP',
              createdById: { not: null },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              videoAssetId: true,
              timestampMs: true,
              cropX: true,
              cropY: true,
              cropWidth: true,
              cropHeight: true,
              createdAt: true,
            },
          }),
    ]);

    const latestRunByAsset = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (run.videoAssetId !== null && !latestRunByAsset.has(run.videoAssetId)) {
        latestRunByAsset.set(run.videoAssetId, run);
      }
    }
    const latestJobBySource = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      if (job.sourceId !== null && !latestJobBySource.has(job.sourceId)) {
        latestJobBySource.set(job.sourceId, job);
      }
    }
    const latestOperatorCropByAsset = new Map<
      string,
      (typeof operatorCrops)[number]
    >();
    for (const crop of operatorCrops) {
      if (!latestOperatorCropByAsset.has(crop.videoAssetId)) {
        latestOperatorCropByAsset.set(crop.videoAssetId, crop);
      }
    }

    const visionEventIds = [...latestJobBySource.values()]
      .map((job) => job.visionEventId)
      .filter((id): id is string => id !== null);
    const events =
      visionEventIds.length === 0
        ? []
        : await this.prisma.visionEvent.findMany({
            where: { tenantId, id: { in: visionEventIds } },
            select: {
              id: true,
              status: true,
              review: { select: { decision: true } },
            },
          });
    const eventById = new Map(events.map((event) => [event.id, event]));

    // Bootstrap pilot reviews (Codex P1 — run-scoped and evidence-bound):
    // only reviews of the LINKED evaluation run count, and each must be
    // tied to the clip's LATEST fusion run's imported event — a review of
    // older evidence, or from another run, satisfies nothing here.
    const journeyEvents =
      assetIds.length === 0
        ? []
        : await this.prisma.customerJourneyEvent.findMany({
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              sourceType: 'FUSION_SHADOW',
            },
            select: {
              id: true,
              videoAssetId: true,
              fusionRunId: true,
              productId: true,
              sku: true,
              eventType: true,
            },
          });
    const journeyEventIds = journeyEvents.map((event) => event.id);
    const pilotReviews =
      linkedRun === null || journeyEventIds.length === 0
        ? []
        : await this.prisma.pilotObservationReview.findMany({
            where: {
              tenantId,
              evaluationRunId: linkedRun.id,
              journeyEventId: { in: journeyEventIds },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              journeyEventId: true,
              verdict: true,
              expectedAction: true,
              expectedProductId: true,
              expectedSku: true,
              operatorCropArtifactId: true,
              createdAt: true,
            },
          });
    const latestReviewByEvent = new Map<
      string,
      (typeof pilotReviews)[number]
    >();
    for (const review of pilotReviews) {
      if (review.journeyEventId !== null) {
        // ascending order → the newest review wins.
        latestReviewByEvent.set(review.journeyEventId, review);
      }
    }
    // Latest-run-bound review per asset, plus a stale marker when only
    // older-run evidence was ever reviewed.
    const latestRunReviewByAsset = new Map<
      string,
      (typeof pilotReviews)[number]
    >();
    const hasOlderReviewByAsset = new Set<string>();
    for (const event of journeyEvents) {
      if (event.videoAssetId === null) {
        continue;
      }
      const review = latestReviewByEvent.get(event.id);
      if (!review) {
        continue;
      }
      const latestRun = latestRunByAsset.get(event.videoAssetId);
      if (latestRun && event.fusionRunId === latestRun.id) {
        const current = latestRunReviewByAsset.get(event.videoAssetId);
        if (!current || review.createdAt > current.createdAt) {
          latestRunReviewByAsset.set(event.videoAssetId, review);
        }
      } else {
        hasOlderReviewByAsset.add(event.videoAssetId);
      }
    }
    // The latest-run event per asset (for the eligibility mirror).
    const latestRunEventByAsset = new Map<
      string,
      (typeof journeyEvents)[number]
    >();
    for (const event of journeyEvents) {
      if (event.videoAssetId === null) {
        continue;
      }
      const latestRun = latestRunByAsset.get(event.videoAssetId);
      if (latestRun && event.fusionRunId === latestRun.id) {
        latestRunEventByAsset.set(event.videoAssetId, event);
      }
    }

    const videos: BootstrapVideoRow[] = liveTruths.map((truth) => {
      const run = latestRunByAsset.get(truth.videoAssetId);
      const job = latestJobBySource.get(pickupSourceId(truth.videoAssetId));
      const event = job?.visionEventId
        ? eventById.get(job.visionEventId)
        : undefined;
      const expectedSku = truth.product?.sku ?? null;
      const native =
        truth.videoAsset.width && truth.videoAsset.height
          ? {
              width: truth.videoAsset.width,
              height: truth.videoAsset.height,
            }
          : null;

      const excludedReason: BootstrapExclusionReason | null =
        truth.videoAsset.sessionId !== null
          ? 'SESSION_BOUND'
          : truth.videoAsset.locationId === null
            ? 'MISSING_STORE_CONTEXT'
            : null;

      const pilotReview = latestRunReviewByAsset.get(truth.videoAssetId);
      const reviewedEvent = latestRunEventByAsset.get(truth.videoAssetId);
      const reviewSnapshot =
        pilotReview !== undefined
          ? {
              verdict: pilotReview.verdict,
              expectedAction: pilotReview.expectedAction,
              expectedProductId: pilotReview.expectedProductId,
              expectedSku: pilotReview.expectedSku,
            }
          : null;
      const eventSnapshot =
        reviewedEvent !== undefined
          ? {
              productId: reviewedEvent.productId,
              sku: reviewedEvent.sku,
              eventType: reviewedEvent.eventType,
            }
          : null;
      const phase18Shaped =
        reviewSnapshot !== null &&
        eventSnapshot !== null &&
        isPhase18EligibleReview(reviewSnapshot, eventSnapshot);
      // Ground-truth drift (Codex P1): an eligible-shaped review whose
      // EFFECTIVE labels no longer match the clip's CURRENT (editable)
      // ground truth is STALE — the truth changed after the review, and
      // exporting/counting it would mislabel the clip. Re-review required.
      const truthConsistent =
        phase18Shaped &&
        reviewSnapshot !== null &&
        eventSnapshot !== null &&
        matchesCurrentGroundTruth(reviewSnapshot, eventSnapshot, {
          eventKind: truth.eventKind,
          productId: truth.productId ?? null,
          sku: expectedSku,
        });
      const reviewEligible = phase18Shaped && truthConsistent;
      const staleTruthReview = phase18Shaped && !truthConsistent;
      const staleReview =
        pilotReview === undefined &&
        hasOlderReviewByAsset.has(truth.videoAssetId);

      let fusion = run
        ? safeFusionSummary(run, expectedSku, fusionFrameDimsFor(native))
        : null;
      // A NEWER manual crop supersedes the automatic crop as evidence
      // (preview, warnings, CLEAN_CROP). Manual boxes are native-pixel.
      // It only counts as CONNECTED evidence once the latest-run review
      // structurally references THIS crop (operatorCropArtifactId —
      // the same field Phase 18 copies into its candidates).
      const operatorCrop = latestOperatorCropByAsset.get(truth.videoAssetId);
      if (
        fusion &&
        run &&
        operatorCrop &&
        operatorCrop.createdAt > run.createdAt &&
        operatorCrop.cropX !== null &&
        operatorCrop.cropY !== null &&
        operatorCrop.cropWidth !== null &&
        operatorCrop.cropHeight !== null
      ) {
        const connected =
          pilotReview !== undefined &&
          pilotReview.operatorCropArtifactId === operatorCrop.id;
        fusion = applyOperatorCrop(
          fusion,
          {
            artifactId: operatorCrop.id,
            timestampMs: operatorCrop.timestampMs,
            box: {
              x: operatorCrop.cropX,
              y: operatorCrop.cropY,
              width: operatorCrop.cropWidth,
              height: operatorCrop.cropHeight,
            },
            createdAt: operatorCrop.createdAt,
          },
          native,
          connected,
        );
      }

      const isNone = truth.eventKind === GroundTruthEventKind.NONE;

      // Reviewed rules (Codex P1): only Phase 18-ELIGIBLE bootstrap
      // reviews on the LATEST evidence count. The one event-less
      // exception: a NONE clip whose FUSION analysis COMPLETED and
      // proposed nothing has no reviewable observation — the operator's
      // NONE label is the record. STRICTLY a non-FAILED fusion run
      // (Codex P2): a FAILED run proves nothing, and a v1 detection job
      // alone is NOT completed fusion analysis either — the fallback
      // must not sneak a half-analyzed clip past ALL_REVIEWED.
      const hasAnalysis =
        run !== undefined && run.policy !== FusionPolicyResult.FAILED;
      const missedPositiveEvent =
        !isNone &&
        job?.status === InferenceJobStatus.SUCCEEDED &&
        event === undefined &&
        !reviewEligible;
      const reviewed = reviewEligible
        ? true
        : isNone &&
          hasAnalysis &&
          event === undefined &&
          fusion?.policy !== 'AUTO_PROPOSE' &&
          reviewedEvent === undefined;

      const predictionMatchesExpected =
        fusion === null
          ? null
          : isNone
            ? fusion.policy !== 'AUTO_PROPOSE'
            : fusion.topSku !== null && fusion.topSku === expectedSku;

      return {
        videoAssetId: truth.videoAssetId,
        originalFilename: truth.videoAsset.originalFilename,
        assetStatus: truth.videoAsset.status,
        durationMs: truth.videoAsset.durationMs,
        eventKind: truth.eventKind,
        testType: truth.testType,
        expectedSku,
        quantity: truth.quantity,
        actualTimestampMs: truth.actualTimestampMs,
        expectedBasketDelta:
          truth.eventKind === GroundTruthEventKind.PICKUP
            ? truth.quantity
            : truth.eventKind === GroundTruthEventKind.RETURN
              ? -truth.quantity
              : 0,
        excludedReason,
        missedPositiveEvent,
        reviewed,
        staleReview,
        staleTruthReview,
        reviewDecision: event?.review?.decision ?? null,
        bootstrapReviewVerdict: pilotReview?.verdict ?? null,
        bootstrapReviewEligible: reviewEligible,
        visionEventStatus: event?.status ?? null,
        needsReview:
          !reviewed &&
          (event?.status === 'PENDING_REVIEW' ||
            fusion?.vlmRequiresHumanReview === true ||
            missedPositiveEvent ||
            staleReview ||
            staleTruthReview),
        predictedSku: fusion?.topSku ?? null,
        predictionMatchesExpected,
        fusion,
      };
    });

    // Every count and gate reads BOOTSTRAP-SAFE clips only: excluded
    // rows (session-bound / no store context) are displayed but can
    // neither satisfy nor block readiness.
    const includedRows = videos.filter((row) => row.excludedReason === null);
    const excludedClips = videos.length - includedRows.length;

    const reviewedPickupExamples = includedRows.filter(
      (row) =>
        row.eventKind === GroundTruthEventKind.PICKUP &&
        row.expectedSku === product.sku &&
        row.bootstrapReviewEligible &&
        row.bootstrapReviewVerdict !== PilotObservationVerdict.FALSE_TOUCH,
    ).length;
    const reviewedReturnExamples = includedRows.filter(
      (row) =>
        row.eventKind === GroundTruthEventKind.RETURN &&
        row.expectedSku === product.sku &&
        row.bootstrapReviewEligible &&
        row.bootstrapReviewVerdict !== PilotObservationVerdict.FALSE_TOUCH,
    ).length;
    const reviewedFalseTouchExamples = includedRows.filter(
      (row) =>
        // NONE ground truth ONLY (Codex P1): a false-touch example must
        // BE a false touch — a mislabeled positive clip never counts.
        row.eventKind === GroundTruthEventKind.NONE &&
        row.bootstrapReviewEligible &&
        row.bootstrapReviewVerdict === PilotObservationVerdict.FALSE_TOUCH,
    ).length;
    const unreviewedClips = includedRows.filter((row) => !row.reviewed).length;

    // Latest fusion evidence by RUN timestamp (Codex P1) over INCLUDED
    // rows: an edited old clip must not surface stale evidence, and an
    // excluded clip must not drive the CLEAN_CROP gate.
    let latestFusion: SafeFusionSummary | null = null;
    for (const row of includedRows) {
      if (
        row.fusion !== null &&
        // No-proposal TRUE NEGATIVES carry no product crop by design —
        // a correct rejection must not displace the positive product
        // evidence the CLEAN_CROP gate scores (Codex P1: recording the
        // documented false-touch clips would otherwise flip the gate to
        // NO_CLEAR_PRODUCT_FRAME and lock readiness out).
        row.fusion.topSku !== null &&
        (latestFusion === null || row.fusion.createdAt > latestFusion.createdAt)
      ) {
        latestFusion = row.fusion;
      }
    }

    const inferenceReady = referenceCount >= PICKUP_MIN_REFERENCE_IMAGES;
    // Full-aggregate total (Codex P2) — never derived from the bounded
    // display rows.
    const totalOnHand = stockAggregate._sum.quantity ?? 0;

    return {
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        status: product.status,
      },
      references: {
        referenceCount,
        minRequired: PICKUP_MIN_REFERENCE_IMAGES,
        recommended: RECOMMENDED_REFERENCE_IMAGES,
        inferenceReady,
        embeddingCount,
        embeddingModelKey: EMBEDDING_MODEL_KEY,
        embeddingModelVersion: EMBEDDING_MODEL_VERSION,
        embeddingsBuilt:
          referenceCount > 0 && embeddingCount >= referenceCount,
      },
      inventory: {
        stocked: totalOnHand > 0,
        detailsVisible: inventoryDetailsVisible,
        // Redacted (Codex P1) unless the caller clears the inventory
        // API's own bar: no exact quantities, no location names/codes,
        // no tenant-wide total for vision-only access.
        totalOnHand: inventoryDetailsVisible ? totalOnHand : null,
        levels: inventoryDetailsVisible
          ? levels.map((level) => ({
              locationId: level.locationId,
              locationName: level.location.name,
              locationCode: level.location.code,
              quantity: level.quantity,
            }))
          : [],
      },
      videoDetailsVisible,
      // CENTRAL video-boundary redaction (Codex P1): EVERY video-,
      // fusion-, and crop-derived field leaves through this one gate —
      // per-clip rows, the latest fusion summary (predicted SKU, score,
      // policy, VLM result, run timestamp), and the fusion-derived
      // failure rollup. Gate DETAILS are redacted inside evaluateGates
      // via the same flag; what remains for a redacted caller is
      // aggregate readiness only (booleans and counts).
      // Display-bounded (newest first) — every count/gate above was
      // computed over the FULL set, so the cap only limits what renders.
      videos: videoDetailsVisible ? videos.slice(0, BOOTSTRAP_MAX_CLIPS) : [],
      counts: {
        totalClips: includedRows.length,
        excludedClips,
        reviewedPickupExamples,
        reviewedReturnExamples,
        reviewedFalseTouchExamples,
        unreviewedClips,
      },
      linkedEvaluationRun: linkedRun
        ? {
            evaluationRunId: linkedRun.id,
            name: linkedRun.name,
            status: linkedRun.status,
            reviewCount: linkedRun._count.reviews,
          }
        : null,
      latest:
        videoDetailsVisible && latestFusion
          ? {
              predictedSku: latestFusion.topSku,
              topScore: latestFusion.topScore,
              policy: latestFusion.policy,
              vlmVerdict: latestFusion.vlmVerdict,
              vlmStatus: latestFusion.vlmStatus,
              runCreatedAt: latestFusion.createdAt,
            }
          : null,
      failureReasons: videoDetailsVisible
        ? deriveFailureReasons(includedRows, { inferenceReady })
        : [],
      gates: evaluateGates({
        referenceCount,
        minRequiredReferences: PICKUP_MIN_REFERENCE_IMAGES,
        embeddingCount,
        stockedQuantity: totalOnHand,
        inventoryDetailsVisible,
        videoDetailsVisible,
        latestFusion,
        reviewedPickupExamples,
        reviewedReturnExamples,
        reviewedFalseTouchExamples,
        unreviewedClips,
        linkedEvaluationReviewCount: linkedRun
          ? linkedRun._count.reviews
          : null,
      }),
      scoreNote: SCORE_NOTE,
    };
  }
}
