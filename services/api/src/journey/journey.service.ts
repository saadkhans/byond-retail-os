import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  CustomerJourneyDecision,
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  FusionPolicyResult,
  JourneyEventReviewDecision,
  Prisma,
  UserType,
} from '@prisma/client';
import { AuditLogService } from '../common/audit/audit-log.service';
import { journeyAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';

/**
 * Customer-journey SKELETON — SHADOW MODE ONLY.
 *
 * The journey is an append-only observation stream; the provisional
 * basket is a pure FOLD over PRODUCT_PICKUP / PRODUCT_RETURN events. This
 * service reads and writes ONLY the two journey tables: no checkout
 * session, order, payment, or inventory mutation exists anywhere in this
 * module (the repository invariant "CV proposes, inventory validates,
 * billing is elsewhere" — billing is deliberately absent here).
 */

export interface ProvisionalBasketLine {
  productId: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
}

export interface JourneyIssue {
  kind:
    | 'REVIEW_EVENT'
    | 'UNKNOWN_PRODUCT_EVENT'
    | 'NEGATIVE_QUANTITY'
    | 'RETURN_WITHOUT_PICKUP';
  detail: string;
  eventId?: string;
}

/** One append-only reviewer decision over one journey observation. */
export interface JourneyEventReviewView {
  id: string;
  decision: JourneyEventReviewDecision;
  correctedEventType: CustomerJourneyEventType | null;
  correctedProductId: string | null;
  correctedSku: string | null;
  correctedProductName: string | null;
  correctedQuantity: number | null;
  reason: string | null;
  reviewedById: string | null;
  createdAt: Date;
}

/** SAFE summary of an imported fusion run — descriptor fields only; the
 *  evidence JSON's rawPreview/errorDetail/OCR text never leave the API. */
export interface JourneyFusionRunSummary {
  runId: string;
  videoAssetId: string;
  pipelineVersion: string;
  policy: FusionPolicyResult;
  fusedTopSku: string | null;
  /** Uncalibrated ranking score, not a probability. */
  fusedTopScore: number | null;
  createdAt: Date;
  vlm: {
    invoked: boolean;
    status: string | null;
    verdict: string | null;
    selectedSku: string | null;
    requiresHumanReview: boolean;
    reasonCodes: string[];
    contradictions: string[];
  } | null;
}

export interface JourneyDetail {
  id: string;
  locationId: string;
  unitId: string | null;
  status: CustomerJourneyStatus;
  decision: CustomerJourneyDecision | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  startedAt: Date;
  endedAt: Date | null;
  events: {
    id: string;
    eventType: CustomerJourneyEventType;
    occurredAt: Date;
    productId: string | null;
    sku: string | null;
    productName: string | null;
    quantity: number;
    matchScore: number | null;
    sourceType: string;
    videoAssetId: string | null;
    fusionRunId: string | null;
    note: string | null;
    reviews: JourneyEventReviewView[];
  }[];
  basket: ProvisionalBasketLine[];
  issues: JourneyIssue[];
  fusionRuns: JourneyFusionRunSummary[];
}

/** The review fields the fold needs — a subset of the stored row. */
export interface FoldReview {
  id: string;
  eventId: string;
  decision: JourneyEventReviewDecision;
  correctedEventType: CustomerJourneyEventType | null;
  correctedProductId: string | null;
  correctedSku: string | null;
  correctedProductName: string | null;
  correctedQuantity: number | null;
  createdAt: Date;
}

/**
 * Pure basket fold — exported for direct testing.
 *
 * Phase 11: the fold is review-aware. Reviews are APPEND-ONLY corrections
 * that never rewrite the observation rows — the LATEST review per event
 * (createdAt, then id) decides how that event contributes:
 *   REJECT  → the event contributes nothing and raises no issue;
 *   APPROVE → a product event counts as-is; a REVIEW_REQUIRED event is
 *             resolved as a non-event (reviewed, nothing to add);
 *   CORRECT → the event counts as the reviewer's product/quantity/kind.
 * Fold-arithmetic issues (RETURN_WITHOUT_PICKUP, NEGATIVE_QUANTITY) still
 * surface for corrected events — a correction fixes an observation, not
 * the journey's consistency.
 */
export function foldBasket(
  events: {
    id: string;
    eventType: CustomerJourneyEventType;
    productId: string | null;
    sku: string | null;
    productName: string | null;
    quantity: number;
  }[],
  reviews: FoldReview[] = [],
): { basket: ProvisionalBasketLine[]; issues: JourneyIssue[] } {
  // Latest review per event wins. Sort defensively — callers pass rows in
  // createdAt order, but a pure function should not depend on it.
  const latestReview = new Map<string, FoldReview>();
  for (const review of [...reviews].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )) {
    latestReview.set(review.eventId, review);
  }
  const lines = new Map<string, ProvisionalBasketLine>();
  const issues: JourneyIssue[] = [];
  for (const original of events) {
    const review = latestReview.get(original.id);
    if (review?.decision === JourneyEventReviewDecision.REJECT) {
      continue;
    }
    let event = original;
    if (review?.decision === JourneyEventReviewDecision.CORRECT) {
      const effectiveType = review.correctedEventType ?? original.eventType;
      if (
        effectiveType !== CustomerJourneyEventType.PRODUCT_PICKUP &&
        effectiveType !== CustomerJourneyEventType.PRODUCT_RETURN
      ) {
        // A correction that names no product event kind (only possible for
        // a REVIEW_REQUIRED original — the service requires the kind there)
        // resolves the observation without a basket effect.
        continue;
      }
      event = {
        id: original.id,
        eventType: effectiveType,
        productId: review.correctedProductId,
        sku: review.correctedSku,
        productName: review.correctedProductName,
        quantity: review.correctedQuantity ?? original.quantity,
      };
    }
    if (event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED) {
      if (review?.decision === JourneyEventReviewDecision.APPROVE) {
        // Reviewed and resolved as a non-event: nothing was taken.
        continue;
      }
      issues.push({
        kind: 'REVIEW_EVENT',
        detail: 'an observation needs human review',
        eventId: event.id,
      });
      continue;
    }
    if (
      event.eventType !== CustomerJourneyEventType.PRODUCT_PICKUP &&
      event.eventType !== CustomerJourneyEventType.PRODUCT_RETURN
    ) {
      continue;
    }
    if (!event.productId) {
      issues.push({
        kind: 'UNKNOWN_PRODUCT_EVENT',
        detail: `${event.eventType} with no identified product`,
        eventId: event.id,
      });
      continue;
    }
    const line =
      lines.get(event.productId) ?? {
        productId: event.productId,
        sku: event.sku,
        productName: event.productName,
        quantity: 0,
      };
    if (event.eventType === CustomerJourneyEventType.PRODUCT_PICKUP) {
      line.quantity += event.quantity;
    } else {
      if (line.quantity - event.quantity < 0 && line.quantity === 0) {
        issues.push({
          kind: 'RETURN_WITHOUT_PICKUP',
          detail: `${event.sku ?? event.productId} returned without an observed pickup`,
          eventId: event.id,
        });
      }
      line.quantity -= event.quantity;
    }
    lines.set(event.productId, line);
  }
  for (const line of lines.values()) {
    if (line.quantity < 0) {
      issues.push({
        kind: 'NEGATIVE_QUANTITY',
        detail: `${line.sku ?? line.productId} folded to ${line.quantity}`,
      });
    }
  }
  return {
    basket: [...lines.values()].filter((line) => line.quantity !== 0),
    issues,
  };
}

/**
 * Pure final-decision rule — exported for direct testing. FAILED is never
 * produced here: the service sets it only when reconciliation itself
 * throws. The reason string is built from issue-kind counts ONLY — never
 * from event free text, which would echo operator notes into a summary
 * field.
 */
export function decideJourney(issues: JourneyIssue[]): {
  decision: CustomerJourneyDecision;
  reason: string;
} {
  const count = (kinds: JourneyIssue['kind'][]) =>
    issues.filter((issue) => kinds.includes(issue.kind)).length;
  const journeyLevel = count(['RETURN_WITHOUT_PICKUP', 'NEGATIVE_QUANTITY']);
  const eventLevel = count(['REVIEW_EVENT', 'UNKNOWN_PRODUCT_EVENT']);
  if (journeyLevel > 0) {
    return {
      decision: CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
      reason: `${journeyLevel} journey-level inconsistenc${
        journeyLevel === 1 ? 'y' : 'ies'
      } (returns without pickups / negative quantities)`,
    };
  }
  if (eventLevel > 0) {
    return {
      decision: CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
      reason: `${eventLevel} unresolved event${
        eventLevel === 1 ? '' : 's'
      } awaiting review`,
    };
  }
  return {
    decision: CustomerJourneyDecision.READY_TO_SETTLE_SHADOW,
    reason: 'no unresolved issues — shadow basket is consistent',
  };
}

/**
 * Pure AGGREGATE stock check — exported for direct testing. Fusion
 * validates each observation independently, and shadow mode reserves
 * nothing: with one unit on hand, two individually-PLAUSIBLE pickups can
 * fold to a basket inventory cannot satisfy. Before a journey is declared
 * READY_TO_SETTLE_SHADOW, the FOLDED per-SKU totals are compared against
 * the on-hand projection (returns already reduced the fold). Read-only by
 * construction: the caller passes quantities it READ — nothing here (or
 * anywhere in this module) writes or reserves inventory.
 *
 * `onHandByProductId` has an entry per basket product that HAS a level
 * row; a missing entry means the product is not stocked at this location
 * and cannot satisfy any quantity. Reasons are built from SKU snapshots
 * and counts only — never event free text.
 */
export function validateAggregateBasket(
  basket: ProvisionalBasketLine[],
  onHandByProductId: Map<string, number>,
): { ok: boolean; reason: string | null } {
  const short: string[] = [];
  for (const line of basket) {
    if (!line.productId || line.quantity <= 0) {
      continue;
    }
    const onHand = onHandByProductId.get(line.productId);
    if (onHand === undefined || line.quantity > onHand) {
      short.push(line.sku ?? line.productId);
    }
  }
  if (short.length === 0) {
    return { ok: true, reason: null };
  }
  return {
    ok: false,
    reason: `aggregate basket exceeds on-hand stock for ${short.join(', ')}`,
  };
}

/** SAFE extraction of the VLM block from a run's evidence JSON: named
 *  descriptor fields only — rawPreview / errorDetail / OCR text are
 *  deliberately not read, let alone returned. */
function vlmSummaryFromEvidence(
  evidence: unknown,
): JourneyFusionRunSummary['vlm'] {
  const vlm = (evidence as { vlm?: unknown } | null)?.vlm;
  if (!vlm || typeof vlm !== 'object') {
    return null;
  }
  const record = vlm as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const codes = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  return {
    invoked: record.invoked === true,
    status: text(record.status),
    verdict: text(record.verdict),
    selectedSku: text(record.selectedSku),
    requiresHumanReview: record.requiresHumanReview === true,
    reasonCodes: codes(record.reasonCodes),
    contradictions: codes(record.contradictions),
  };
}

@Injectable()
export class JourneyService {
  private readonly logger = new Logger(JourneyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async create(
    tenantId: string,
    input: { locationId: string; unitId?: string | null },
    actorId?: string,
  ) {
    const location = await this.prisma.location.findFirst({
      where: { tenantId, id: input.locationId },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException('Store not found in this tenant');
    }
    if (input.unitId) {
      // TENANT ISOLATION at the data-access boundary: the schema's unit
      // relation is keyed by id alone, so the unit must be resolved
      // within BOTH this tenant and this location before it is written —
      // otherwise a known foreign unit id links a journey across tenants
      // (or across stores of the same tenant).
      const unit = await this.prisma.retailUnit.findFirst({
        where: { tenantId, id: input.unitId, locationId: input.locationId },
        select: { id: true },
      });
      if (!unit) {
        throw new NotFoundException('Unit not found in this store');
      }
    }
    // ATOMIC open: the journey row and its ENTRY event become visible
    // together. If the ENTRY insert failed after the journey committed,
    // an OPEN journey with no ENTRY event would remain and a retry would
    // open a SECOND journey for the same shopper.
    const journey = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customerJourney.create({
        data: {
          tenantId,
          locationId: input.locationId,
          unitId: input.unitId ?? null,
        },
      });
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId: created.id,
          eventType: CustomerJourneyEventType.ENTRY,
          occurredAt: new Date(),
          sourceType: 'MANUAL',
          createdById: actorId ?? null,
        },
      });
      return created;
    });
    return this.detail(tenantId, journey.id);
  }

  /**
   * Serialize every journey mutation behind the per-journey advisory lock
   * and re-check OPEN inside the SAME transaction as the write. Without
   * this, an append that passed the open check could commit after exit()
   * folded the basket and marked the journey RECONCILED — a closed
   * journey with an unaccounted event but a clean status.
   */
  private async withOpenJourney<T>(
    tenantId: string,
    journeyId: string,
    work: (
      tx: Prisma.TransactionClient,
      journey: { id: string; locationId: string; unitId: string | null },
    ) => Promise<T>,
  ): Promise<T> {
    return this.withJourney(tenantId, journeyId, async (tx, journey) => {
      if (journey.status !== CustomerJourneyStatus.OPEN) {
        throw new ConflictException('Journey is no longer open');
      }
      return work(tx, journey);
    });
  }

  /** Same lock + tenant-scoped re-read, WITHOUT the OPEN requirement —
   *  reviews target exited journeys too. Every journey mutation still
   *  serializes behind the per-journey advisory lock. */
  private async withJourney<T>(
    tenantId: string,
    journeyId: string,
    work: (
      tx: Prisma.TransactionClient,
      journey: {
        id: string;
        locationId: string;
        unitId: string | null;
        status: CustomerJourneyStatus;
      },
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${journeyAdvisoryLockKey(
        tenantId,
        journeyId,
      )}))::text`;
      const journey = await tx.customerJourney.findFirst({
        where: { tenantId, id: journeyId },
      });
      if (!journey) {
        throw new NotFoundException('Journey not found');
      }
      return work(tx, journey);
    });
  }

  /**
   * Fold + decide + persist, inside the caller's locked transaction. The
   * SHADOW decision is a recorded conclusion: nothing here (or anywhere in
   * this module) creates checkout sessions, orders, payment intents, or
   * payment events. FAILED is reserved for reconciliation itself
   * throwing — the journey then lands in REVIEW_REQUIRED instead of
   * presenting a half-computed basket as settled.
   */
  private async reconcile(
    tx: Prisma.TransactionClient,
    tenantId: string,
    journeyId: string,
    locationId: string,
    options: { setEndedAt: boolean },
  ): Promise<void> {
    let decision: CustomerJourneyDecision;
    let reason: string;
    try {
      // TENANT SCOPE on every read, including the nested/derived ones:
      // relation and composite-FK integrity are the backstop, never the
      // predicate (repo rule: every tenant-data query carries tenantId).
      const events = await tx.customerJourneyEvent.findMany({
        where: { tenantId, journeyId },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      });
      const reviews = await tx.customerJourneyEventReview.findMany({
        where: { tenantId, journeyId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const { basket, issues } = foldBasket(events, reviews);
      ({ decision, reason } = decideJourney(issues));
      if (decision === CustomerJourneyDecision.READY_TO_SETTLE_SHADOW) {
        // AGGREGATE stock check before declaring the shadow basket
        // settleable — READ-ONLY lookups of the on-hand projection at the
        // journey's store; no inventory write or reservation exists in
        // shadow mode.
        const onHand = new Map<string, number>();
        for (const line of basket) {
          if (!line.productId || line.quantity <= 0) {
            continue;
          }
          const level = await tx.inventoryLevel.findFirst({
            where: { tenantId, locationId, productId: line.productId },
            select: { quantity: true },
          });
          if (level) {
            onHand.set(line.productId, level.quantity);
          }
        }
        const aggregate = validateAggregateBasket(basket, onHand);
        if (!aggregate.ok) {
          decision = CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW;
          reason = aggregate.reason!;
        }
      }
    } catch (error) {
      this.logger.error(
        `journey ${journeyId} reconciliation failed`,
        error instanceof Error ? error.stack : String(error),
      );
      decision = CustomerJourneyDecision.FAILED;
      reason = 'reconciliation failed unexpectedly — see server logs';
    }
    await tx.customerJourney.update({
      where: { id_tenantId: { id: journeyId, tenantId } },
      data: {
        status:
          decision === CustomerJourneyDecision.READY_TO_SETTLE_SHADOW
            ? CustomerJourneyStatus.RECONCILED
            : CustomerJourneyStatus.REVIEW_REQUIRED,
        decision,
        decisionReason: reason,
        decidedAt: new Date(),
        ...(options.setEndedAt ? { endedAt: new Date() } : {}),
      },
    });
  }

  async appendEvent(
    tenantId: string,
    journeyId: string,
    input: {
      eventType: CustomerJourneyEventType;
      occurredAt?: string;
      productId?: string | null;
      quantity?: number;
      matchScore?: number | null;
      sourceType?: string;
      videoAssetId?: string | null;
      fusionRunId?: string | null;
      note?: string | null;
    },
    actorId?: string,
  ) {
    if (input.eventType === CustomerJourneyEventType.ENTRY) {
      throw new BadRequestException('ENTRY is recorded when the journey opens');
    }
    if (input.eventType === CustomerJourneyEventType.EXIT) {
      throw new BadRequestException('Use the exit endpoint for EXIT');
    }
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new BadRequestException('quantity must be a whole number 1..100');
    }
    // The note is caller free text that persists verbatim and echoes back
    // on every journey read — same reject-on-write screen as the video
    // screening note (Phase 7 policy): no credential- or payment-bearing
    // content ever touches storage. Gated at the service level so every
    // append path is covered.
    if (
      input.note !== undefined &&
      input.note !== null &&
      containsSensitiveFreeText(input.note)
    ) {
      throw new BadRequestException(
        'note must not contain credential- or payment-bearing content',
      );
    }
    await this.withOpenJourney(tenantId, journeyId, async (tx) => {
      // IDEMPOTENT fusion imports: one VIDEO may contribute at most one
      // fusion observation per journey. The dedup keys on (journeyId,
      // videoAssetId) rather than the run id because fusion runs are
      // append-only and freely re-runnable — after a re-run, the "latest
      // run" indirection hands a repeated import a FRESH run id that a
      // run-id-only check would wave through, double-counting one physical
      // observation. Checked under the journey lock, in the same
      // transaction as the insert, so a retry replays instead of doubling
      // the provisional basket.
      if (input.sourceType === 'FUSION_SHADOW' && input.videoAssetId) {
        const existing = await tx.customerJourneyEvent.findFirst({
          where: {
            tenantId,
            journeyId,
            videoAssetId: input.videoAssetId,
            sourceType: 'FUSION_SHADOW',
          },
          select: { id: true },
        });
        if (existing) {
          return;
        }
      }
      let snapshot: { sku: string; name: string } | null = null;
      if (input.productId) {
        const product = await tx.product.findFirst({
          where: { tenantId, id: input.productId },
          select: { sku: true, name: true },
        });
        if (!product) {
          throw new BadRequestException('Product not found in this tenant');
        }
        snapshot = { sku: product.sku, name: product.name };
      } else if (
        input.eventType === CustomerJourneyEventType.PRODUCT_PICKUP ||
        input.eventType === CustomerJourneyEventType.PRODUCT_RETURN
      ) {
        throw new BadRequestException(
          'PRODUCT_PICKUP/PRODUCT_RETURN need a product — record ' +
            'REVIEW_REQUIRED for unidentified observations',
        );
      }
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId,
          eventType: input.eventType,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          productId: input.productId ?? null,
          sku: snapshot?.sku ?? null,
          productName: snapshot?.name ?? null,
          quantity,
          matchScore: input.matchScore ?? null,
          sourceType: input.sourceType ?? 'MANUAL',
          videoAssetId: input.videoAssetId ?? null,
          fusionRunId: input.fusionRunId ?? null,
          note: input.note?.slice(0, 500) ?? null,
          createdById: actorId ?? null,
        },
      });
    });
    return this.detail(tenantId, journeyId);
  }

  /**
   * Import the LATEST fusion shadow run of a video asset as journey
   * observations: an AUTO_PROPOSE pickup/return becomes the corresponding
   * product event (canonical productId + score); anything else becomes
   * REVIEW_REQUIRED. Nothing is fabricated — the run's own evidence is
   * the only source.
   */
  async appendFromFusionRun(
    tenantId: string,
    journeyId: string,
    videoAssetId: string,
    actorId?: string,
  ) {
    const journey = await this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      select: { locationId: true, unitId: true },
    });
    if (!journey) {
      throw new NotFoundException('Journey not found');
    }
    // STORE-CONTEXT MATCH: an observation captured in one store must not
    // land in a journey opened in another. The asset must exist in this
    // tenant AND carry the journey's location (and, when both sides pin a
    // unit, the same unit). locationId/unitId are immutable after journey
    // creation, so this pre-append check cannot go stale.
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: { locationId: true, unitId: true, createdAt: true },
    });
    if (!asset) {
      throw new NotFoundException('Video asset not found in this tenant');
    }
    if (asset.locationId === null || asset.locationId !== journey.locationId) {
      throw new ConflictException(
        "the video's store context does not match this journey's store",
      );
    }
    if (journey.unitId && asset.unitId && asset.unitId !== journey.unitId) {
      throw new ConflictException(
        "the video's unit does not match this journey's unit",
      );
    }
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!run) {
      throw new NotFoundException('No fusion run exists for that video');
    }
    const evidence = run.evidence as {
      detector?: { events?: { kind?: string; peakMs?: number }[] };
      fused?: { productId: string; sku: string; productName: string }[];
    };
    const detectedKind = evidence.detector?.events?.[0]?.kind;
    // SOURCE TIME, not import time: the v1 pipeline stamps its event at
    // asset.createdAt + eventPeakMs, and the ordered basket fold trusts
    // occurredAt — a late or out-of-order clip import stamped "now" would
    // fabricate chronology (e.g. a spurious RETURN_WITHOUT_PICKUP when the
    // return clip imports before the pickup clip). Missing/garbage peakMs
    // falls back to append-time stamping, the pre-existing behavior.
    const peakMs = evidence.detector?.events?.[0]?.peakMs;
    const occurredAt =
      typeof peakMs === 'number' && Number.isFinite(peakMs)
        ? new Date(
            asset.createdAt.getTime() + Math.max(0, Math.round(peakMs)),
          ).toISOString()
        : undefined;
    const top = evidence.fused?.[0];
    if (run.policy === FusionPolicyResult.AUTO_PROPOSE && top) {
      return this.appendEvent(
        tenantId,
        journeyId,
        {
          eventType:
            detectedKind === 'RETURN'
              ? CustomerJourneyEventType.PRODUCT_RETURN
              : CustomerJourneyEventType.PRODUCT_PICKUP,
          occurredAt,
          productId: top.productId,
          matchScore: run.fusedTopScore,
          sourceType: 'FUSION_SHADOW',
          videoAssetId,
          fusionRunId: run.id,
          note: `policy ${run.policy}`,
        },
        actorId,
      );
    }
    return this.appendEvent(
      tenantId,
      journeyId,
      {
        eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
        occurredAt,
        sourceType: 'FUSION_SHADOW',
        videoAssetId,
        fusionRunId: run.id,
        matchScore: run.fusedTopScore,
        note: `policy ${run.policy}${run.fusedTopSku ? ` · top ${run.fusedTopSku}` : ''}`,
      },
      actorId,
    );
  }

  /** EXIT + reconciliation: fold the (review-aware) basket, surface
   *  unresolved issues, and settle status + the final SHADOW decision —
   *  RECONCILED/READY_TO_SETTLE_SHADOW only when clean. Runs entirely
   *  under the per-journey lock so no append can land between the fold
   *  and the status transition. The decision mutates ONLY the journey
   *  row — never checkout, order, payment, or inventory state. */
  async exit(tenantId: string, journeyId: string, actorId?: string) {
    await this.withOpenJourney(tenantId, journeyId, async (tx, journey) => {
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId,
          eventType: CustomerJourneyEventType.EXIT,
          occurredAt: new Date(),
          sourceType: 'MANUAL',
          createdById: actorId ?? null,
        },
      });
      // Tenant-scoped via the composite unique key inside reconcile(): id
      // alone must never address another tenant's journey, even after
      // withOpenJourney's scoped lookup (the write itself enforces
      // isolation).
      await this.reconcile(tx, tenantId, journeyId, journey.locationId, {
        setEndedAt: true,
      });
    });
    return this.detail(tenantId, journeyId);
  }

  /**
   * Reviewer decision over ONE observation — APPEND-ONLY and audited.
   * The observation row is never rewritten (DB triggers reject UPDATE);
   * the review row and its AuditLog entry commit atomically, and the fold
   * applies the latest review per event on read. On a closed journey the
   * final decision is recomputed in the same transaction. No review
   * outcome creates or mutates checkout, order, payment, or inventory
   * state.
   */
  async reviewEvent(
    tenantId: string,
    journeyId: string,
    eventId: string,
    input: {
      decision: JourneyEventReviewDecision;
      reason?: string | null;
      correctedEventType?: CustomerJourneyEventType | null;
      correctedProductId?: string | null;
      correctedQuantity?: number | null;
      idempotencyKey?: string | null;
    },
    actor: { id: string; email: string },
  ) {
    // Same reject-on-write screen as journey notes: reviewer free text
    // persists and echoes back on every read.
    if (
      input.reason !== undefined &&
      input.reason !== null &&
      containsSensitiveFreeText(input.reason)
    ) {
      throw new BadRequestException(
        'reason must not contain credential- or payment-bearing content',
      );
    }
    const isCorrect = input.decision === JourneyEventReviewDecision.CORRECT;
    if (!isCorrect) {
      if (
        input.correctedEventType != null ||
        input.correctedProductId != null ||
        input.correctedQuantity != null
      ) {
        throw new BadRequestException(
          'corrected fields are only valid with a CORRECT decision',
        );
      }
    } else {
      if (!input.correctedProductId) {
        throw new BadRequestException(
          'CORRECT requires correctedProductId and correctedQuantity',
        );
      }
      const quantity = input.correctedQuantity;
      if (!Number.isInteger(quantity) || quantity! < 1 || quantity! > 100) {
        throw new BadRequestException(
          'correctedQuantity must be a whole number 1..100',
        );
      }
    }
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    // A stored review "is the same action" when decision + corrected
    // payload all match; correctedEventType is compared only when the
    // caller supplied one (product events default it server-side).
    const matchesStored = (stored: {
      decision: JourneyEventReviewDecision;
      correctedEventType: CustomerJourneyEventType | null;
      correctedProductId: string | null;
      correctedQuantity: number | null;
    }) =>
      stored.decision === input.decision &&
      stored.correctedProductId ===
        (isCorrect ? input.correctedProductId! : null) &&
      stored.correctedQuantity ===
        (isCorrect ? input.correctedQuantity! : null) &&
      (!isCorrect ||
        input.correctedEventType == null ||
        stored.correctedEventType === input.correctedEventType);
    const replayOrConflict = (stored: Parameters<typeof matchesStored>[0]) => {
      if (!matchesStored(stored)) {
        throw new ConflictException(
          'idempotency key was already used for a different review action',
        );
      }
      // REPLAY: the first attempt committed (review + audit); a retry
      // whose response was lost gets the same outcome with no second
      // immutable record of the same human action.
    };
    try {
      await this.withJourney(tenantId, journeyId, async (tx, journey) => {
        const event = await tx.customerJourneyEvent.findFirst({
          where: { tenantId, journeyId, id: eventId },
        });
        if (!event) {
          throw new NotFoundException('Event not found in this journey');
        }
        if (
          event.eventType !== CustomerJourneyEventType.PRODUCT_PICKUP &&
          event.eventType !== CustomerJourneyEventType.PRODUCT_RETURN &&
          event.eventType !== CustomerJourneyEventType.REVIEW_REQUIRED
        ) {
          throw new BadRequestException(
            'only PRODUCT_PICKUP / PRODUCT_RETURN / REVIEW_REQUIRED ' +
              'observations are reviewable',
          );
        }
        // REVIEWER ATTRIBUTION is resolved at the data-access boundary,
        // not trusted from the request context: reviewedById must name a
        // user of THIS tenant. Platform users (tenantId null) act through
        // the server-resolved platform-sandbox tenant — the same reason
        // the same-tenant-FK migrations deliberately exempt user
        // attribution columns — so they pass on userType, never on a
        // tenant match.
        const reviewer = await tx.user.findFirst({
          where: { id: actor.id },
          select: { id: true, tenantId: true, userType: true },
        });
        if (
          !reviewer ||
          (reviewer.userType !== UserType.PLATFORM &&
            reviewer.tenantId !== tenantId)
        ) {
          throw new ForbiddenException(
            'reviewer does not belong to this tenant',
          );
        }
        // IDEMPOTENT reviews: a lost-response retry replays instead of
        // appending a second immutable record. Checked under the journey
        // lock, in the same transaction as the insert; tenant-scoped like
        // every read here.
        if (idempotencyKey) {
          const existing = await tx.customerJourneyEventReview.findFirst({
            where: { tenantId, eventId, idempotencyKey },
          });
          if (existing) {
            replayOrConflict(existing);
            return;
          }
        }
        let correctedEventType: CustomerJourneyEventType | null = null;
        let snapshot: { sku: string; name: string } | null = null;
        if (isCorrect) {
          // A REVIEW_REQUIRED original has no product kind of its own — the
          // reviewer must say whether it was a pickup or a return. Product
          // events default to their observed kind.
          correctedEventType =
            input.correctedEventType ??
            (event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED
              ? null
              : event.eventType);
          if (
            correctedEventType !== CustomerJourneyEventType.PRODUCT_PICKUP &&
            correctedEventType !== CustomerJourneyEventType.PRODUCT_RETURN
          ) {
            throw new BadRequestException(
              'CORRECT on a REVIEW_REQUIRED observation requires ' +
                'correctedEventType PRODUCT_PICKUP or PRODUCT_RETURN',
            );
          }
          // TENANT ISOLATION: the corrected product is resolved within this
          // tenant before anything is written — a known foreign product id
          // must never enter another tenant's journey.
          const product = await tx.product.findFirst({
            where: { tenantId, id: input.correctedProductId! },
            select: { sku: true, name: true },
          });
          if (!product) {
            throw new BadRequestException('Product not found in this tenant');
          }
          snapshot = { sku: product.sku, name: product.name };
        }
        const review = await tx.customerJourneyEventReview.create({
          data: {
            tenantId,
            journeyId,
            eventId,
            decision: input.decision,
            correctedEventType,
            correctedProductId: isCorrect ? input.correctedProductId! : null,
            correctedSku: snapshot?.sku ?? null,
            correctedProductName: snapshot?.name ?? null,
            correctedQuantity: isCorrect ? input.correctedQuantity! : null,
            reason: input.reason?.slice(0, 500) ?? null,
            reviewedById: reviewer.id,
            idempotencyKey,
          },
        });
        // Audit commits or rolls back WITH the review (fail closed). CORRECT
        // maps to OVERRIDE — AuditAction's existing reviewer vocabulary.
        // Written only for genuinely NEW reviews — a replay records nothing.
        await this.audit.record(
          {
            tenantId,
            actorId: actor.id,
            actorEmail: actor.email,
            action:
              input.decision === JourneyEventReviewDecision.APPROVE
                ? AuditAction.APPROVE
                : input.decision === JourneyEventReviewDecision.REJECT
                  ? AuditAction.REJECT
                  : AuditAction.OVERRIDE,
            entityType: 'CustomerJourneyEvent',
            entityId: eventId,
            after: {
              reviewId: review.id,
              decision: input.decision,
              correctedEventType,
              correctedProductId: isCorrect ? input.correctedProductId : null,
              correctedSku: snapshot?.sku ?? null,
              correctedQuantity: isCorrect ? input.correctedQuantity : null,
            },
            reason: input.reason?.slice(0, 500),
          },
          tx,
        );
        // A review on a CLOSED journey re-settles the final decision in the
        // same transaction; an OPEN journey decides at exit.
        if (journey.status !== CustomerJourneyStatus.OPEN) {
          await this.reconcile(tx, tenantId, journeyId, journey.locationId, {
            setEndedAt: false,
          });
        }
      });
    } catch (error) {
      // RACE BACKSTOP for the unique (tenantId, eventId, idempotencyKey)
      // index: two concurrent retries both miss the pre-check; the loser's
      // transaction aborts on P2002 and must re-read OUTSIDE it (the
      // aborted tx cannot serve queries) to replay or conflict.
      if (
        idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing =
          await this.prisma.customerJourneyEventReview.findFirst({
            where: { tenantId, eventId, idempotencyKey },
          });
        if (existing) {
          replayOrConflict(existing);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    return this.detail(tenantId, journeyId);
  }

  async list(tenantId: string) {
    const journeys = await this.prisma.customerJourney.findMany({
      where: { tenantId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: { _count: { select: { events: true } } },
    });
    return journeys.map((journey) => ({
      id: journey.id,
      locationId: journey.locationId,
      unitId: journey.unitId,
      status: journey.status,
      decision: journey.decision,
      startedAt: journey.startedAt,
      endedAt: journey.endedAt,
      eventCount: journey._count.events,
    }));
  }

  async detail(tenantId: string, journeyId: string): Promise<JourneyDetail> {
    // TENANT SCOPE at every nesting level, not just the root: the nested
    // event and review reads carry their own tenantId predicate rather
    // than leaning on relation/composite-FK integrity (repo rule — the
    // database constraints are the backstop, never the query filter).
    const journey = await this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      include: {
        events: {
          where: { tenantId },
          orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
          include: {
            reviews: {
              where: { tenantId },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
    });
    if (!journey) {
      throw new NotFoundException('Journey not found');
    }
    const allReviews = journey.events.flatMap((event) => event.reviews ?? []);
    const { basket, issues } = foldBasket(journey.events, allReviews);
    // Imported fusion runs, summarized for the review UI. Tenant-scoped
    // re-read: an event's stored fusionRunId is only ever rendered through
    // a lookup constrained to THIS tenant.
    const runIds = [
      ...new Set(
        journey.events
          .map((event) => event.fusionRunId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const runs =
      runIds.length === 0
        ? []
        : await this.prisma.pickupFusionRun.findMany({
            where: { tenantId, id: { in: runIds } },
            orderBy: [{ createdAt: 'asc' }],
          });
    return {
      id: journey.id,
      locationId: journey.locationId,
      unitId: journey.unitId,
      status: journey.status,
      decision: journey.decision,
      decisionReason: journey.decisionReason,
      decidedAt: journey.decidedAt,
      startedAt: journey.startedAt,
      endedAt: journey.endedAt,
      events: journey.events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        productId: event.productId,
        sku: event.sku,
        productName: event.productName,
        quantity: event.quantity,
        matchScore: event.matchScore,
        sourceType: event.sourceType,
        videoAssetId: event.videoAssetId,
        fusionRunId: event.fusionRunId,
        note: event.note,
        reviews: (event.reviews ?? []).map((review) => ({
          id: review.id,
          decision: review.decision,
          correctedEventType: review.correctedEventType,
          correctedProductId: review.correctedProductId,
          correctedSku: review.correctedSku,
          correctedProductName: review.correctedProductName,
          correctedQuantity: review.correctedQuantity,
          reason: review.reason,
          reviewedById: review.reviewedById,
          createdAt: review.createdAt,
        })),
      })),
      basket,
      issues,
      fusionRuns: runs.map((run) => ({
        runId: run.id,
        videoAssetId: run.videoAssetId,
        pipelineVersion: run.pipelineVersion,
        policy: run.policy,
        fusedTopSku: run.fusedTopSku,
        fusedTopScore: run.fusedTopScore,
        createdAt: run.createdAt,
        vlm: vlmSummaryFromEvidence(run.evidence),
      })),
    };
  }
}
