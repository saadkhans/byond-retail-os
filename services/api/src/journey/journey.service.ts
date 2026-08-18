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
  FusionRunScope,
  JourneyEventReviewDecision,
  Prisma,
  TenantStatus,
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
  /** Null for LIVE_WINDOW runs (Phase 13) — those carry a live session
   *  instead of a video asset. */
  videoAssetId: string | null;
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

/** One uncertain observation awaiting a reviewer — the review-queue row.
 *  Descriptor fields only: evidence stays behind the video-asset routes. */
export interface ReviewQueueItem {
  journeyId: string;
  journeyStatus: CustomerJourneyStatus;
  journeyDecision: CustomerJourneyDecision | null;
  eventId: string;
  eventType: CustomerJourneyEventType;
  occurredAt: Date;
  sourceType: string;
  videoAssetId: string | null;
  fusionRunId: string | null;
  /** Fusion's best candidate when a run is linked, else the event's own
   *  SKU snapshot. */
  candidateSku: string | null;
  /** Uncalibrated ranking score, not a probability. */
  fusedTopScore: number | null;
  vlm: {
    status: string | null;
    verdict: string | null;
    selectedSku: string | null;
    requiresHumanReview: boolean;
  } | null;
  /** Controlled vocabulary — never event free text. The two issue kinds
   *  cover known-product events flagged by unresolved journey-level fold
   *  inconsistencies (Codex P1: those need review too). */
  reason:
    | 'REVIEW_REQUIRED observation'
    | 'unknown product'
    | 'RETURN_WITHOUT_PICKUP'
    | 'NEGATIVE_QUANTITY';
  latestReview: {
    decision: JourneyEventReviewDecision;
    createdAt: Date;
  } | null;
}

/** Queue page bound: oldest-first so long-waiting observations surface. */
export const REVIEW_QUEUE_MAX_ITEMS = 100;

/** Issue-scan paging: candidate journeys are walked in batches and the
 *  queue cap applies to MATCHING rows, never to journeys scanned — a
 *  backlog of non-queueable review journeys must not hide later genuine
 *  fold inconsistencies. The ceiling bounds the walk (safety, not a
 *  visibility limit; ~10× the queue cap). */
export const REVIEW_QUEUE_JOURNEY_BATCH = 50;
export const REVIEW_QUEUE_JOURNEY_SCAN_CEILING = 1000;

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
  // Last effective RETURN event per product — a NEGATIVE_QUANTITY issue
  // is anchored to the observation that drove the line negative so the
  // review queue has a concrete event to put in front of a human.
  const lastReturnEvent = new Map<string, string>();
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
      lastReturnEvent.set(event.productId, event.id);
    }
    lines.set(event.productId, line);
  }
  for (const line of lines.values()) {
    if (line.quantity < 0) {
      issues.push({
        kind: 'NEGATIVE_QUANTITY',
        detail: `${line.sku ?? line.productId} folded to ${line.quantity}`,
        eventId: line.productId
          ? lastReturnEvent.get(line.productId)
          : undefined,
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

/** Review reason as it is stored, audited, and fingerprint-matched:
 *  trimmed, capped at the 500-char storage bound, empty → null. Exported
 *  for direct testing. */
export function normalizeReviewReason(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
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
    options?: {
      /** Source-time ENTRY stamp. The camera replay runtime anchors the
       *  whole journey timeline to the pilot run's start so ENTRY ≤ every
       *  replayed observation ≤ EXIT regardless of when the footage was
       *  originally uploaded or how fast processing runs. */
      entryAt?: Date;
    },
  ) {
    // ATOMIC open: the journey row and its ENTRY event become visible
    // together. If the ENTRY insert failed after the journey committed,
    // an OPEN journey with no ENTRY event would remain and a retry would
    // open a SECOND journey for the same shopper.
    const journey = await this.prisma.$transaction(async (tx) =>
      this.openJourneyInTransaction(tx, tenantId, input, actorId, options),
    );
    return this.detail(tenantId, journey.journeyId);
  }

  /**
   * Open a journey INSIDE a caller-owned transaction (Phase 13): the
   * live-session runtime must create its journey and link it onto the
   * session row ATOMICALLY — a journey existing without its session link
   * is an orphan waiting to happen, so both writes commit or neither
   * does. Validations run on the SAME transaction client; the caller
   * performs its own linking write in the same transaction and lets the
   * whole thing roll back on any failure.
   */
  async openJourneyInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: { locationId: string; unitId?: string | null },
    actorId?: string,
    options?: { entryAt?: Date },
  ): Promise<{ journeyId: string }> {
    const location = await tx.location.findFirst({
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
      const unit = await tx.retailUnit.findFirst({
        where: { tenantId, id: input.unitId, locationId: input.locationId },
        select: { id: true },
      });
      if (!unit) {
        throw new NotFoundException('Unit not found in this store');
      }
    }
    const entryAt = options?.entryAt ?? new Date();
    const created = await tx.customerJourney.create({
      data: {
        tenantId,
        locationId: input.locationId,
        unitId: input.unitId ?? null,
        startedAt: entryAt,
      },
    });
    await tx.customerJourneyEvent.create({
      data: {
        tenantId,
        journeyId: created.id,
        eventType: CustomerJourneyEventType.ENTRY,
        occurredAt: entryAt,
        sourceType: 'MANUAL',
        createdById: actorId ?? null,
      },
    });
    return { journeyId: created.id };
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
    options: { setEndedAt: boolean; endedAt?: Date },
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
        ...(options.setEndedAt
          ? { endedAt: options.endedAt ?? new Date() }
          : {}),
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
      /** Fusion-import idempotency scope — see the dedup comment below. */
      dedupScope?: 'video' | 'run';
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
      // IDEMPOTENT fusion imports. Default ('video') scope: one VIDEO may
      // contribute at most one fusion observation per journey — dedup keys
      // on (journeyId, videoAssetId) rather than the run id because fusion
      // runs are append-only and freely re-runnable; the "latest run"
      // indirection would hand a repeated import a FRESH run id that a
      // run-id-only check waves through, double-counting one physical
      // observation. The camera replay runtime instead imports SEVERAL
      // window-scoped fusion runs of one video into one fresh journey it
      // owns — there the physical observation is the RUN ('run' scope),
      // and cross-run double-counting cannot occur because each replay
      // opens its own journey. Checked under the journey lock, in the
      // same transaction as the insert, so a retry replays instead of
      // doubling the provisional basket.
      if (input.sourceType === 'FUSION_SHADOW' && input.videoAssetId) {
        const existing = await tx.customerJourneyEvent.findFirst({
          where: {
            tenantId,
            journeyId,
            sourceType: 'FUSION_SHADOW',
            ...(input.dedupScope === 'run' && input.fusionRunId
              ? { fusionRunId: input.fusionRunId }
              : { videoAssetId: input.videoAssetId }),
          },
          select: { id: true },
        });
        if (existing) {
          return;
        }
      }
      // LIVE imports (Phase 13) have NO video asset — the run itself is
      // the physical observation, and a live session imports each of its
      // window runs exactly once into the journey it owns.
      if (input.sourceType === 'LIVE_SHADOW' && input.fusionRunId) {
        const existing = await tx.customerJourneyEvent.findFirst({
          where: {
            tenantId,
            journeyId,
            sourceType: 'LIVE_SHADOW',
            fusionRunId: input.fusionRunId,
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
    options?: {
      /** Import THIS run (tenant-scoped, must belong to the video) instead
       *  of the newest one — the camera replay runtime binds each window's
       *  observation to the exact run it created, never a latest-row
       *  lookup a concurrent replay could race. Switches dedup to 'run'
       *  scope so several window runs of one video can land in one
       *  replay-owned journey. */
      fusionRunId?: string;
      /** Source-time base for occurredAt (replay runs stamp relative to
       *  the RUN start, not the original upload's createdAt — an old
       *  asset replayed today must not predate the journey's ENTRY). */
      sourceTimeBase?: Date;
      /** Deterministic offset used when the run's evidence has NO
       *  detector peak (a no-detection window): with a sourceTimeBase the
       *  observation must still land on the replay timeline — never on
       *  the wall clock, which can drift past the source-time EXIT when
       *  processing outruns the footage. Callers pass the replay window's
       *  peak (or midpoint/start); absent, the base itself is used. */
      fallbackPeakMs?: number;
    },
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
    const run = options?.fusionRunId
      ? await this.prisma.pickupFusionRun.findFirst({
          where: { tenantId, id: options.fusionRunId, videoAssetId },
        })
      : await this.prisma.pickupFusionRun.findFirst({
          // The "latest run" convenience path means the latest WHOLE_CLIP
          // analysis — a camera replay's window-scoped runs of the same
          // video must never be what a manual import silently picks up.
          where: { tenantId, videoAssetId, runScope: FusionRunScope.WHOLE_CLIP },
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
    const sourceTimeBase = options?.sourceTimeBase ?? asset.createdAt;
    const effectivePeakMs =
      typeof peakMs === 'number' && Number.isFinite(peakMs)
        ? peakMs
        : options?.sourceTimeBase !== undefined
          ? Math.max(0, options.fallbackPeakMs ?? 0)
          : null;
    const occurredAt =
      effectivePeakMs !== null
        ? new Date(
            sourceTimeBase.getTime() + Math.max(0, Math.round(effectivePeakMs)),
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
          dedupScope: options?.fusionRunId ? 'run' : 'video',
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
        dedupScope: options?.fusionRunId ? 'run' : 'video',
      },
      actorId,
    );
  }

  /**
   * Import ONE live-window fusion run (Phase 13) as a journey
   * observation. Live runs have no video asset: the run is resolved
   * tenant-scoped by exact id, its owning live session supplies the
   * store context (the session's camera must sit in the journey's
   * store), and observations stamp on the session's source timeline —
   * sourceTimeBase (the session start) + the detector peak, falling back
   * to the sampler window's peak so a no-detection import never lands on
   * the wall clock. Idempotent per run id. Shadow only, like every other
   * journey write.
   */
  async appendFromLiveFusionRun(
    tenantId: string,
    journeyId: string,
    fusionRunId: string,
    actorId?: string,
    options?: { sourceTimeBase?: Date; fallbackPeakMs?: number },
  ) {
    const journey = await this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      select: { locationId: true, unitId: true },
    });
    if (!journey) {
      throw new NotFoundException('Journey not found');
    }
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: {
        tenantId,
        id: fusionRunId,
        runScope: FusionRunScope.LIVE_WINDOW,
        liveSessionId: { not: null },
      },
    });
    if (!run || !run.liveSessionId) {
      throw new NotFoundException('Live fusion run not found in this tenant');
    }
    const session = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, id: run.liveSessionId },
      select: { cameraSourceId: true, startedAt: true },
    });
    if (!session) {
      throw new NotFoundException('Live session not found in this tenant');
    }
    const camera = await this.prisma.cameraSource.findFirst({
      where: { tenantId, id: session.cameraSourceId },
      select: { locationId: true, unitId: true },
    });
    // STORE-CONTEXT MATCH, same rule as the video import: an observation
    // captured by one store's camera must not land in a journey opened
    // in another.
    if (!camera || camera.locationId !== journey.locationId) {
      throw new ConflictException(
        "the camera's store context does not match this journey's store",
      );
    }
    if (journey.unitId && camera.unitId && camera.unitId !== journey.unitId) {
      throw new ConflictException(
        "the camera's unit does not match this journey's unit",
      );
    }
    const evidence = run.evidence as {
      detector?: { events?: { kind?: string; peakMs?: number }[] };
      fused?: { productId: string; sku: string; productName: string }[];
    };
    const detectedKind = evidence.detector?.events?.[0]?.kind;
    const peakMs = evidence.detector?.events?.[0]?.peakMs;
    const sourceTimeBase = options?.sourceTimeBase ?? session.startedAt;
    const effectivePeakMs =
      typeof peakMs === 'number' && Number.isFinite(peakMs)
        ? peakMs
        : Math.max(0, options?.fallbackPeakMs ?? 0);
    const occurredAt = new Date(
      sourceTimeBase.getTime() + Math.max(0, Math.round(effectivePeakMs)),
    ).toISOString();
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
          sourceType: 'LIVE_SHADOW',
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
        sourceType: 'LIVE_SHADOW',
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
  async exit(
    tenantId: string,
    journeyId: string,
    actorId?: string,
    options?: {
      /** Source-time EXIT stamp (see create's entryAt) — the replay
       *  runtime sets entry + duration + a margin so a replay processed
       *  FASTER than the footage's own timeline can never place an
       *  observation after EXIT. */
      exitAt?: Date;
    },
  ) {
    const exitAt = options?.exitAt ?? new Date();
    await this.withOpenJourney(tenantId, journeyId, async (tx, journey) => {
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId,
          eventType: CustomerJourneyEventType.EXIT,
          occurredAt: exitAt,
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
        endedAt: exitAt,
      });
    });
    return this.detail(tenantId, journeyId);
  }

  /**
   * Failure cleanup for runtime-owned journeys (camera replay): when a
   * replay pipeline fails after opening its journey, the journey must not
   * linger OPEN with only an ENTRY event. Records a source-time EXIT and
   * settles the journey as FAILED with a CONTROLLED reason code — never
   * pipeline free text. Shadow mode: mutates only the journey tables.
   */
  async abortShadowJourney(
    tenantId: string,
    journeyId: string,
    reasonCode: string,
    actorId?: string,
    options?: { exitAt?: Date },
  ) {
    const exitAt = options?.exitAt ?? new Date();
    await this.withOpenJourney(tenantId, journeyId, async (tx) => {
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId,
          eventType: CustomerJourneyEventType.EXIT,
          occurredAt: exitAt,
          sourceType: 'SYSTEM',
          note: `aborted: ${reasonCode}`.slice(0, 500),
          createdById: actorId ?? null,
        },
      });
      await tx.customerJourney.update({
        where: { id_tenantId: { id: journeyId, tenantId } },
        data: {
          status: CustomerJourneyStatus.REVIEW_REQUIRED,
          decision: CustomerJourneyDecision.FAILED,
          decisionReason: `replay aborted: ${reasonCode}`.slice(0, 500),
          decidedAt: new Date(),
          endedAt: exitAt,
        },
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
    // Normalized ONCE and used for the insert, the audit row, and the
    // idempotency fingerprint, so all three always agree: trimmed,
    // capped at the storage bound, empty collapsing to null.
    const normalizedReason = normalizeReviewReason(input.reason);
    // A stored review "is the same action" when decision + corrected
    // payload + reason all match; correctedEventType is compared only
    // when the caller supplied one (product events default it
    // server-side). The reason is PART of the immutable record — a retry
    // that changes it is a different action, and silently keeping the
    // first reason while reporting success would misrepresent what the
    // reviewer wrote.
    const matchesStored = (stored: {
      decision: JourneyEventReviewDecision;
      correctedEventType: CustomerJourneyEventType | null;
      correctedProductId: string | null;
      correctedQuantity: number | null;
      reason: string | null;
    }) =>
      stored.decision === input.decision &&
      normalizeReviewReason(stored.reason) === normalizedReason &&
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
        // An unidentified product event cannot be APPROVEd: approval
        // changes nothing in the fold (UNKNOWN_PRODUCT_EVENT stays), yet
        // any landed review removes the row from the review queue — the
        // unresolved work would silently vanish. The reviewer must either
        // CORRECT it with a product or REJECT it. (APPROVE on a
        // REVIEW_REQUIRED observation stays allowed — that decision
        // resolves it as a non-event by design.)
        if (
          input.decision === JourneyEventReviewDecision.APPROVE &&
          event.eventType !== CustomerJourneyEventType.REVIEW_REQUIRED &&
          event.productId === null
        ) {
          throw new BadRequestException(
            'an unidentified product cannot be approved — CORRECT it ' +
              'with a product or REJECT it',
          );
        }
        // A KNOWN-product event implicated in an unresolved journey-level
        // fold inconsistency (RETURN_WITHOUT_PICKUP / NEGATIVE_QUANTITY)
        // cannot be APPROVEd either: approval changes nothing in the fold
        // — the observation would count exactly as before, the issue
        // would persist, and the journey would stay review-required while
        // the queue row vanished. The reviewer must CORRECT the
        // observation (fixing the arithmetic) or REJECT it (Codex P1).
        if (
          input.decision === JourneyEventReviewDecision.APPROVE &&
          (event.eventType === CustomerJourneyEventType.PRODUCT_PICKUP ||
            event.eventType === CustomerJourneyEventType.PRODUCT_RETURN)
        ) {
          const journeyEvents = await tx.customerJourneyEvent.findMany({
            where: { tenantId, journeyId },
            orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
          });
          const journeyReviews = await tx.customerJourneyEventReview.findMany(
            {
              where: { tenantId, journeyId },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          );
          const { issues } = foldBasket(journeyEvents, journeyReviews);
          const implicated = issues.some(
            (issue) =>
              (issue.kind === 'RETURN_WITHOUT_PICKUP' ||
                issue.kind === 'NEGATIVE_QUANTITY') &&
              issue.eventId === eventId,
          );
          if (implicated) {
            throw new BadRequestException(
              'this observation is part of an unresolved journey ' +
                'inconsistency — CORRECT or REJECT it',
            );
          }
        }
        // REVIEWER ATTRIBUTION is resolved at the data-access boundary
        // with the SAME tenant scoping as every other read here — never a
        // global lookup that could authorize a user against a tenant they
        // do not belong to. A TENANT reviewer must be a user OF this
        // tenant. A PLATFORM reviewer (tenantId null — the reason the
        // same-tenant-FK migrations exempt user attribution columns) is
        // accepted ONLY when this journey's tenant is the VERIFIED
        // platform sandbox — the isPlatformSandbox marker introduced in
        // Phase 10, mirroring AuthRepository.findPlatformSandboxTenantId;
        // the reserved slug alone is not identity. Platform users act in
        // the sandbox and nowhere else, so a customer-tenant review can
        // never be attributed to a platform-only user.
        let reviewerId: string;
        const tenantReviewer = await tx.user.findFirst({
          where: { id: actor.id, tenantId },
          select: { id: true },
        });
        if (tenantReviewer) {
          reviewerId = tenantReviewer.id;
        } else {
          const platformReviewer = await tx.user.findFirst({
            where: { id: actor.id, userType: UserType.PLATFORM, tenantId: null },
            select: { id: true },
          });
          const verifiedSandbox = platformReviewer
            ? await tx.tenant.findFirst({
                where: {
                  id: tenantId,
                  status: TenantStatus.ACTIVE,
                  isPlatformSandbox: true,
                },
                select: { id: true },
              })
            : null;
          if (!platformReviewer || !verifiedSandbox) {
            throw new ForbiddenException(
              'reviewer does not belong to this tenant',
            );
          }
          reviewerId = platformReviewer.id;
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
            reason: normalizedReason,
            reviewedById: reviewerId,
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
            reason: normalizedReason ?? undefined,
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

  /**
   * The review queue: every observation in this tenant that still needs a
   * human decision, oldest first. Direct rows (REVIEW_REQUIRED /
   * unknown-product observations) leave the queue when a review lands
   * (unidentified products cannot be APPROVEd — see reviewEvent — so what
   * leaves is genuinely handled). Issue rows (RETURN_WITHOUT_PICKUP /
   * NEGATIVE_QUANTITY) are governed by FOLD RESOLUTION instead: they stay
   * queued — even past a historical APPROVE — until the review-aware fold
   * stops flagging them. Both streams are collected in full (within their
   * own scan bounds), merged and deduped by event id (issue reason wins),
   * sorted oldest-first, and ONLY THEN capped — direct rows can never
   * starve inconsistency rows out of the page. READ-ONLY:
   * approve/reject/correct continue through the existing review endpoint;
   * no second mutation path exists here.
   */
  async reviewQueue(tenantId: string): Promise<ReviewQueueItem[]> {
    // TENANT SCOPE at every nesting level (repo rule): the event query,
    // the nested review read, and every follow-up lookup each carry their
    // own tenantId predicate.
    //
    // UNRESOLVED IS A DATABASE PREDICATE, applied BEFORE the page bound
    // (Codex P1): `reviews: { none: … }` — post-fetch filtering must
    // never decide visibility, or a backlog of older resolved rows would
    // crowd newer unresolved observations out of the scan window.
    const unresolvedDirect = await this.prisma.customerJourneyEvent.findMany({
      where: {
        tenantId,
        reviews: { none: { tenantId } },
        OR: [
          { eventType: CustomerJourneyEventType.REVIEW_REQUIRED },
          {
            eventType: {
              in: [
                CustomerJourneyEventType.PRODUCT_PICKUP,
                CustomerJourneyEventType.PRODUCT_RETURN,
              ],
            },
            productId: null,
          },
        ],
      },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      take: REVIEW_QUEUE_MAX_ITEMS,
      include: {
        reviews: {
          where: { tenantId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { decision: true, createdAt: true },
        },
      },
    });
    type QueueEvent = (typeof unresolvedDirect)[number];
    const candidates = new Map<
      string,
      { event: QueueEvent; reason: ReviewQueueItem['reason'] }
    >();
    for (const event of unresolvedDirect) {
      candidates.set(event.id, {
        event,
        reason:
          event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED
            ? 'REVIEW_REQUIRED observation'
            : 'unknown product',
      });
    }
    // KNOWN-PRODUCT events flagged by unresolved journey-level fold
    // issues (RETURN_WITHOUT_PICKUP / NEGATIVE_QUANTITY) belong in the
    // queue too (Codex P1): a pilot run can report review-needed work
    // that the type/product predicate above would never surface.
    //
    // Membership is decided by FOLD RESOLUTION, never by mere review
    // existence: an APPROVEd inconsistency stays queued (approval changes
    // nothing in the fold — reviewEvent rejects it going forward, and
    // historical approvals must not have buried the work), and a CORRECT
    // that does not fix the arithmetic keeps the row too. The event
    // leaves the queue only when the review-aware fold stops flagging it
    // (REJECT drops the observation; an arithmetic-fixing CORRECT clears
    // the issue).
    //
    // Candidate journeys are PAGED and the cap applies to MATCHING rows,
    // not to the journeys scanned (Codex P1): a backlog of older
    // review-decision journeys without queueable fold issues must not
    // hide a newer journey's genuine inconsistency. A hard scan ceiling
    // keeps the walk bounded.
    //
    // The scan runs to the ceiling REGARDLESS of how many direct rows
    // were collected (Codex P1, round 3): both streams are gathered IN
    // FULL (within their own bounds), merged, and only the MERGED result
    // is capped below — 100 direct unresolved rows must never starve the
    // inconsistency stream, whose rows may be older than every direct
    // row and therefore sort ahead of them.
    let scannedJourneys = 0;
    while (scannedJourneys < REVIEW_QUEUE_JOURNEY_SCAN_CEILING) {
      const batch = await this.prisma.customerJourney.findMany({
        where: {
          tenantId,
          decision: {
            in: [
              CustomerJourneyDecision.NEEDS_EVENT_REVIEW,
              CustomerJourneyDecision.NEEDS_JOURNEY_REVIEW,
            ],
          },
        },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        skip: scannedJourneys,
        take: REVIEW_QUEUE_JOURNEY_BATCH,
        select: { id: true },
      });
      if (batch.length === 0) {
        break;
      }
      scannedJourneys += batch.length;
      const flaggedEvents = await this.prisma.customerJourneyEvent.findMany({
        where: {
          tenantId,
          journeyId: { in: batch.map((journey) => journey.id) },
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        include: {
          reviews: {
            where: { tenantId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      const byJourney = new Map<string, typeof flaggedEvents>();
      for (const event of flaggedEvents) {
        const list = byJourney.get(event.journeyId) ?? [];
        list.push(event);
        byJourney.set(event.journeyId, list);
      }
      for (const journeyEvents of byJourney.values()) {
        const { issues } = foldBasket(
          journeyEvents,
          journeyEvents.flatMap((event) => event.reviews ?? []),
        );
        for (const issue of issues) {
          if (
            (issue.kind !== 'RETURN_WITHOUT_PICKUP' &&
              issue.kind !== 'NEGATIVE_QUANTITY') ||
            !issue.eventId
          ) {
            continue;
          }
          // MERGE + DEDUPE by event id: one row per event. When an event
          // qualifies through both streams the ISSUE reason wins — the
          // fold inconsistency is the more specific, more actionable
          // finding, and its resolution rule (fold-driven) is the
          // stricter of the two.
          const existing = candidates.get(issue.eventId);
          if (
            existing &&
            (existing.reason === 'RETURN_WITHOUT_PICKUP' ||
              existing.reason === 'NEGATIVE_QUANTITY')
          ) {
            continue;
          }
          const event =
            existing?.event ??
            journeyEvents.find((row) => row.id === issue.eventId);
          if (!event) {
            continue;
          }
          candidates.set(event.id, { event, reason: issue.kind });
        }
      }
      if (batch.length < REVIEW_QUEUE_JOURNEY_BATCH) {
        break;
      }
    }
    // Final page: sort the MERGED set (occurredAt asc, event id for
    // stability) and apply the cap only now — after both streams landed.
    const unresolved = [...candidates.values()]
      .sort(
        (a, b) =>
          a.event.occurredAt.getTime() - b.event.occurredAt.getTime() ||
          (a.event.id < b.event.id ? -1 : 1),
      )
      .slice(0, REVIEW_QUEUE_MAX_ITEMS);
    const reasonByEventId = new Map(
      unresolved.map(({ event, reason }) => [event.id, reason]),
    );
    const unresolvedEvents = unresolved.map(({ event }) => event);
    // Journeys re-read tenant-scoped rather than included through the
    // to-one relation (which cannot carry its own where clause).
    const journeyIds = [
      ...new Set(unresolvedEvents.map((event) => event.journeyId)),
    ];
    const journeys =
      journeyIds.length === 0
        ? []
        : await this.prisma.customerJourney.findMany({
            where: { tenantId, id: { in: journeyIds } },
            select: { id: true, status: true, decision: true },
          });
    const journeyById = new Map(journeys.map((row) => [row.id, row]));
    const runIds = [
      ...new Set(
        unresolvedEvents
          .map((event) => event.fusionRunId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const runs =
      runIds.length === 0
        ? []
        : await this.prisma.pickupFusionRun.findMany({
            where: { tenantId, id: { in: runIds } },
            select: {
              id: true,
              fusedTopSku: true,
              fusedTopScore: true,
              evidence: true,
            },
          });
    const runById = new Map(runs.map((run) => [run.id, run]));
    const items: ReviewQueueItem[] = [];
    for (const event of unresolvedEvents) {
      const journey = journeyById.get(event.journeyId);
      if (!journey) {
        // The tenant-scoped journey re-read found no owner — never render
        // an orphan (defense in depth; the composite FK makes this
        // unreachable in a healthy database).
        continue;
      }
      const run = event.fusionRunId
        ? (runById.get(event.fusionRunId) ?? null)
        : null;
      const vlm = run ? vlmSummaryFromEvidence(run.evidence) : null;
      const latest = (event.reviews ?? [])[event.reviews.length - 1] ?? null;
      items.push({
        journeyId: event.journeyId,
        journeyStatus: journey.status,
        journeyDecision: journey.decision,
        eventId: event.id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        sourceType: event.sourceType,
        videoAssetId: event.videoAssetId,
        fusionRunId: event.fusionRunId,
        candidateSku: run?.fusedTopSku ?? event.sku,
        fusedTopScore: run?.fusedTopScore ?? event.matchScore,
        vlm: vlm
          ? {
              status: vlm.status,
              verdict: vlm.verdict,
              selectedSku: vlm.selectedSku,
              requiresHumanReview: vlm.requiresHumanReview,
            }
          : null,
        reason:
          reasonByEventId.get(event.id) ??
          (event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED
            ? 'REVIEW_REQUIRED observation'
            : 'unknown product'),
        latestReview: latest
          ? { decision: latest.decision, createdAt: latest.createdAt }
          : null,
      });
    }
    return items;
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
