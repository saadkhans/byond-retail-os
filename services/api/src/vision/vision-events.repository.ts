import { Injectable } from '@nestjs/common';
import {
  CheckoutSessionLine,
  CheckoutSessionLineStatus,
  EvidenceBundle,
  EvidenceQuality,
  EvidenceSourceType,
  ModuleStatus,
  Prisma,
  ProductStatus,
  VisionBasketEffect,
  VisionEvent,
  VisionEventReview,
  VisionEventStatus,
  VisionEventType,
  VisionReviewDecision,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PG_INT_MAX } from '../common/integer-bounds';
import {
  checkoutSessionAdvisoryLockKey,
  deviceAdvisoryLockKey,
  productStockAdvisoryLockKey,
  unitAdvisoryLockKey,
  visionEventAdvisoryLockKey,
} from '../common/locks';
import { MUTABLE_SESSION_STATUSES } from '../checkout/checkout-sessions.repository';
import { BASKET_AFFECTING_EVENT_TYPES } from '../common/vision-event-policy';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Relations included on every event read (list and detail). */
export const VISION_EVENT_INCLUDE = {
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
  session: { select: { id: true, status: true } },
} satisfies Prisma.VisionEventInclude;

/**
 * Read shape for event LIST rows: an explicit scalar select — no
 * candidates, and NO free-form `metadata` JSON, which is bounded only by
 * the HTTP body limit and could otherwise put megabytes on a single page
 * the table never renders. Metadata is a detail-view concern.
 */
export const VISION_EVENT_LIST_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  unitId: true,
  deviceId: true,
  sessionId: true,
  type: true,
  status: true,
  quantity: true,
  occurredAt: true,
  ingestedAt: true,
  sourceType: true,
  sourceId: true,
  modelName: true,
  modelVersion: true,
  evidenceBundleId: true,
  evidenceScore: true,
  evidenceQuality: true,
  reasonCodes: true,
  idempotencyKey: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
  session: { select: { id: true, status: true } },
} satisfies Prisma.VisionEventSelect;

/**
 * Read shape for event detail: ranked candidates, the decision (when made),
 * the full evidence bundle metadata, and minimal store/unit/device/session
 * references.
 */
export const VISION_EVENT_DETAIL_INCLUDE = {
  ...VISION_EVENT_INCLUDE,
  device: { select: { id: true, name: true, serialNumber: true } },
  candidates: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
  review: true,
  evidenceBundle: true,
} satisfies Prisma.VisionEventInclude;

export type VisionEventWithRefs = Prisma.VisionEventGetPayload<{
  select: typeof VISION_EVENT_LIST_SELECT;
}>;

export type VisionEventDetail = Prisma.VisionEventGetPayload<{
  include: typeof VISION_EVENT_DETAIL_INCLUDE;
}>;

// Moved to common/ so the checkout repository can share it without an
// import cycle; re-exported here for existing importers.
export { BASKET_AFFECTING_EVENT_TYPES };

/** Candidate input, already normalized/validated by the service. */
export interface CandidateInput {
  sku: string;
  rank: number;
  score?: number;
  label?: string;
}

/**
 * Phase 7 lineage-only bundle input: sourceType + capture window. The
 * payload columns (sourceId/modelName/modelVersion/artifacts/metadata)
 * still exist in the schema but are SERVER-CONTROLLED and always left
 * null — evidence payload ingestion is out of scope for Phase 7 MVP.
 */
export interface EvidenceBundleInput {
  sourceType?: EvidenceSourceType;
  captureStartedAt?: Date;
  captureEndedAt?: Date;
}

export interface IngestEventInput {
  locationId: string;
  unitId: string;
  deviceId?: string;
  sessionId?: string;
  type: VisionEventType;
  occurredAt: Date;
  quantity: number;
  candidates: CandidateInput[];
  sourceType?: EvidenceSourceType;
  evidenceBundleId?: string;
  evidenceBundle?: EvidenceBundleInput;
  evidenceScore?: number;
  evidenceQuality?: EvidenceQuality;
  reasonCodes?: string[];
  idempotencyKey?: string;
  createdById?: string;
}

export type IngestRejection =
  | 'location-not-found'
  | 'unit-not-found'
  | 'unit-location-mismatch'
  | 'device-not-found'
  | 'device-unit-mismatch'
  | 'session-not-found'
  | 'session-unit-mismatch'
  | 'session-location-mismatch'
  | 'bundle-not-found'
  | { unknownSkus: string[] };

export interface IngestAuditBuilders {
  eventCreated: (event: VisionEventDetail) => AuditEntry;
  bundleCreated: (bundle: EvidenceBundle) => AuditEntry;
}

export interface ReviewInput {
  decision: VisionReviewDecision;
  /** OVERRIDE only — validated present by the service. */
  productId?: string;
  quantity?: number;
  reason?: string;
  reviewedById?: string;
}

export type ReviewRejection =
  | 'already-decided'
  | 'override-not-applicable'
  | 'no-candidates'
  | 'no-session'
  | 'session-terminal'
  | 'checkout-module-disabled'
  | 'product-not-found'
  | 'product-not-saleable'
  | 'no-line-to-decrement'
  | 'line-quantity-overflow';

export type BindSessionRejection =
  | 'already-decided'
  | 'already-bound'
  | 'session-not-found'
  | 'session-unit-mismatch'
  | 'session-location-mismatch';

export interface ReviewAuditBuilders {
  decided: (before: VisionEvent, after: VisionEventDetail) => AuditEntry;
  reviewCreated: (review: VisionEventReview) => AuditEntry;
  lineAdded: (line: CheckoutSessionLine) => AuditEntry;
  lineChanged: (
    before: CheckoutSessionLine,
    after: CheckoutSessionLine,
  ) => AuditEntry;
  lineRemoved: (before: CheckoutSessionLine) => AuditEntry;
}

@Injectable()
export class VisionEventsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  /**
   * Ingests a normalized event after tenant-scoped reference checks, all
   * inside the insert transaction (with the composite same-tenant FKs in
   * migration SQL as the backstop) — a reference from another tenant is
   * simply "not found" and can never race its way in. Ingestion NEVER
   * mutates the basket or inventory.
   */
  ingest(
    tenantId: string,
    data: IngestEventInput,
    builders: IngestAuditBuilders,
  ): Promise<
    { event: VisionEventDetail; replayed: boolean } | IngestRejection
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      // Idempotent replay: at-least-once edge delivery returns the original
      // event untouched — no duplicate, no audit row, no field merging.
      if (data.idempotencyKey) {
        const existing = await tx.visionEvent.findFirst({
          where: {
            tenantId: scopedTenantId,
            idempotencyKey: data.idempotencyKey,
          },
          include: VISION_EVENT_DETAIL_INCLUDE,
        });
        if (existing) {
          return { event: existing, replayed: true };
        }
      }
      // Serialize with UnitsRepository.update()/delete() (same key), held
      // through the insert — the unit/store validation below must not pass
      // on a read a concurrent unit mutation immediately invalidates. Lock
      // order unit → device mirrors CheckoutSessionsRepository.create(), so
      // the two creation paths cannot deadlock each other.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${unitAdvisoryLockKey(
        scopedTenantId,
        data.unitId,
      )}))`;
      const location = await tx.location.findFirst({
        where: { id: data.locationId, tenantId: scopedTenantId },
        select: { id: true },
      });
      if (!location) {
        return 'location-not-found' as const;
      }
      const unit = await tx.retailUnit.findFirst({
        where: { id: data.unitId, tenantId: scopedTenantId },
        select: { id: true, locationId: true },
      });
      if (!unit) {
        return 'unit-not-found' as const;
      }
      if (unit.locationId !== data.locationId) {
        return 'unit-location-mismatch' as const;
      }
      if (data.deviceId) {
        // Serialize with DevicesRepository.update() (same key): a concurrent
        // reassignment to another unit must not land between this check and
        // the event row, or the event would claim a source device that was
        // no longer attached to the unit at ingest time.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
          scopedTenantId,
          data.deviceId,
        )}))`;
        const device = await tx.device.findFirst({
          where: { id: data.deviceId, tenantId: scopedTenantId },
          select: { id: true, unitId: true },
        });
        if (!device) {
          return 'device-not-found' as const;
        }
        if (device.unitId !== data.unitId) {
          return 'device-unit-mismatch' as const;
        }
      }
      if (data.sessionId) {
        const session = await tx.checkoutSession.findFirst({
          where: { id: data.sessionId, tenantId: scopedTenantId },
          select: { id: true, unitId: true, locationId: true },
        });
        if (!session) {
          return 'session-not-found' as const;
        }
        // An event bound to a session at a DIFFERENT unit would let one
        // shopper's camera event mutate another unit's basket on approval.
        // Session status is deliberately NOT checked here: late events on a
        // finished session are still real observations worth recording —
        // approval (not ingestion) enforces basket mutability.
        if (session.unitId !== data.unitId) {
          return 'session-unit-mismatch' as const;
        }
        // The STORE must match too: a unit can be reassigned to another
        // store while an older mutable session for it still points at the
        // previous store — a new event from the unit's current store must
        // not reach that old store's basket.
        if (session.locationId !== data.locationId) {
          return 'session-location-mismatch' as const;
        }
      }
      // Resolve SKU candidates against the tenant catalog INSIDE the
      // transaction so snapshots come from the rows the FKs will point at.
      // Any unknown SKU rejects the whole event: the vendor-neutral contract
      // is that adapters normalize detections to catalog SKUs upstream.
      const products = data.candidates.length
        ? await tx.product.findMany({
            where: {
              tenantId: scopedTenantId,
              sku: { in: data.candidates.map((candidate) => candidate.sku) },
            },
            select: { id: true, sku: true, name: true },
          })
        : [];
      const productsBySku = new Map(
        products.map((product) => [product.sku, product]),
      );
      const unknownSkus = data.candidates
        .map((candidate) => candidate.sku)
        .filter((sku) => !productsBySku.has(sku));
      if (unknownSkus.length > 0) {
        return { unknownSkus };
      }
      let bundleId = data.evidenceBundleId;
      let createdBundle: EvidenceBundle | null = null;
      if (bundleId) {
        const bundle = await tx.evidenceBundle.findFirst({
          where: { id: bundleId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!bundle) {
          return 'bundle-not-found' as const;
        }
      } else if (data.evidenceBundle) {
        // Lineage-only record: the payload columns (sourceId/modelName/
        // modelVersion/artifacts/metadata) are deliberately never written
        // — Phase 7 accepts no evidence payloads.
        createdBundle = await tx.evidenceBundle.create({
          data: {
            tenantId: scopedTenantId,
            sourceType: data.evidenceBundle.sourceType,
            captureStartedAt: data.evidenceBundle.captureStartedAt,
            captureEndedAt: data.evidenceBundle.captureEndedAt,
            createdById: data.createdById,
          },
        });
        bundleId = createdBundle.id;
      }
      const event = await tx.visionEvent.create({
        data: {
          tenantId: scopedTenantId,
          locationId: data.locationId,
          unitId: data.unitId,
          deviceId: data.deviceId,
          sessionId: data.sessionId,
          type: data.type,
          quantity: data.quantity,
          occurredAt: data.occurredAt,
          sourceType: data.sourceType,
          // sourceId/modelName/modelVersion/metadata are Phase 7 removed
          // payload channels: server-controlled, always null.
          evidenceBundleId: bundleId,
          evidenceScore: data.evidenceScore,
          evidenceQuality: data.evidenceQuality,
          reasonCodes: data.reasonCodes,
          idempotencyKey: data.idempotencyKey,
          createdById: data.createdById,
          candidates: {
            create: data.candidates.map((candidate) => {
              const product = productsBySku.get(candidate.sku)!;
              return {
                tenantId: scopedTenantId,
                productId: product.id,
                rank: candidate.rank,
                score: candidate.score,
                label: candidate.label,
                // Snapshot at ingest time: later catalog edits must not
                // rewrite what the source proposed.
                sku: product.sku,
                productName: product.name,
              };
            }),
          },
        },
        include: VISION_EVENT_DETAIL_INCLUDE,
      });
      if (createdBundle) {
        await this.auditLog.record(builders.bundleCreated(createdBundle), tx);
      }
      await this.auditLog.record(builders.eventCreated(event), tx);
      return { event, replayed: false };
    });
  }

  /** Replay lookup for the ingest P2002 race (two firsts, same key). */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<VisionEventDetail | null> {
    return this.prisma.visionEvent.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
      include: VISION_EVENT_DETAIL_INCLUDE,
    });
  }

  findById(tenantId: string, id: string): Promise<VisionEventDetail | null> {
    return this.prisma.visionEvent.findFirst({
      where: this.scope(tenantId, { id }),
      include: VISION_EVENT_DETAIL_INCLUDE,
    });
  }

  findBundleById(
    tenantId: string,
    id: string,
  ): Promise<EvidenceBundle | null> {
    return this.prisma.evidenceBundle.findFirst({
      where: this.scope(tenantId, { id }),
    });
  }

  async search(
    tenantId: string,
    filters: {
      status?: VisionEventStatus;
      type?: VisionEventType;
      sessionId?: string;
      locationId?: string;
      unitId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: VisionEventWithRefs[]; total: number }> {
    const where: Prisma.VisionEventWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.type) {
      where.type = filters.type;
    }
    if (filters.sessionId) {
      where.sessionId = filters.sessionId;
    }
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.unitId) {
      where.unitId = filters.unitId;
    }
    const [items, total] = await Promise.all([
      this.prisma.visionEvent.findMany({
        where,
        select: VISION_EVENT_LIST_SELECT,
        // id is the deterministic tie-breaker: occurredAt is millisecond
        // precision, so burst events could otherwise reorder across pages.
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.visionEvent.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * The Phase 7 core invariant lives here: the review decision, the event's
   * terminal status flip, and the basket effect it describes commit or roll
   * back as ONE transaction. An approved PRODUCT_PICKUP/CART_INSERTION adds
   * or increases a basket line; an approved PRODUCT_RETURN decreases or
   * (soft-)removes one; PRODUCT_TRANSFER/EXIT_RECONCILIATION are
   * record-only. REJECT never touches the basket.
   *
   * Concurrency, in layers: the vision-event advisory lock serializes
   * decisions on the same event (second decider sees the terminal status);
   * the (tenantId, eventId) unique on VisionEventReview backstops the race;
   * the session advisory lock serializes the basket effect against every
   * checkout line mutation and completion; the product lock serializes the
   * saleability check + snapshot against catalog edits. Lock order
   * vision-event → session → product can never deadlock checkout paths,
   * which take session → product in the same order and never take the
   * vision-event lock.
   */
  review(
    tenantId: string,
    eventId: string,
    input: ReviewInput,
    builders: ReviewAuditBuilders,
  ): Promise<VisionEventDetail | ReviewRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${visionEventAdvisoryLockKey(
        scopedTenantId,
        eventId,
      )}))`;
      const event = await tx.visionEvent.findFirst({
        where: { id: eventId, tenantId: scopedTenantId },
        include: {
          candidates: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!event) {
        return null;
      }
      // Decisions are terminal: an APPROVED/REJECTED/OVERRIDDEN event never
      // changes again. Corrections are new manual basket mutations with
      // their own audit trail — never a rewrite of this decision.
      if (event.status !== VisionEventStatus.PENDING_REVIEW) {
        return 'already-decided' as const;
      }

      const basketAffecting = BASKET_AFFECTING_EVENT_TYPES.includes(
        event.type,
      );
      if (
        input.decision === VisionReviewDecision.OVERRIDE &&
        !basketAffecting
      ) {
        return 'override-not-applicable' as const;
      }

      let appliedProductId: string | null = null;
      let appliedQuantity: number | null = null;
      let basketEffect: VisionBasketEffect = VisionBasketEffect.NONE;
      let sessionLineId: string | null = null;
      let lineAudit: AuditEntry | null = null;

      if (
        input.decision !== VisionReviewDecision.REJECT &&
        basketAffecting
      ) {
        if (input.decision === VisionReviewDecision.OVERRIDE) {
          appliedProductId = input.productId!;
          appliedQuantity = input.quantity!;
        } else {
          // APPROVE applies the strongest candidate at the event quantity.
          const top = event.candidates[0];
          if (!top) {
            return 'no-candidates' as const;
          }
          appliedProductId = top.productId;
          appliedQuantity = event.quantity;
        }
        if (!event.sessionId) {
          return 'no-session' as const;
        }
        // The vision route is gated by the `cv` module, but a basket
        // mutation is CHECKOUT functionality: with checkout disabled for
        // the tenant, this endpoint must not remain a back door that keeps
        // sessions mutable. Same semantics as ModuleEnabledGuard, checked
        // inside the transaction. REJECT and record-only decisions stay
        // available — they never touch the basket.
        const checkoutModule = await tx.platformModule.findUnique({
          where: { code: 'checkout' },
          select: { id: true, isActive: true },
        });
        const tenantCheckout = checkoutModule?.isActive
          ? await tx.tenantModule.findFirst({
              where: {
                tenantId: scopedTenantId,
                moduleId: checkoutModule.id,
                status: ModuleStatus.ENABLED,
              },
              select: { id: true },
            })
          : null;
        if (!tenantCheckout) {
          return 'checkout-module-disabled' as const;
        }
        // Serialize against every checkout basket mutation and completion on
        // this session — the basket effect must not interleave with a line
        // add/update/remove or a completion deciding on a stale basket.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${checkoutSessionAdvisoryLockKey(
          scopedTenantId,
          event.sessionId,
        )}))`;
        const session = await tx.checkoutSession.findFirst({
          where: { id: event.sessionId, tenantId: scopedTenantId },
          select: { id: true, status: true },
        });
        if (!session || !MUTABLE_SESSION_STATUSES.includes(session.status)) {
          return 'session-terminal' as const;
        }
        // Evidence lineage stamped onto basket lines this event CREATES (and
        // onto the tombstone of a line it fully removes — REMOVED lines never
        // complete into orders). Lines that merely aggregate or decrement
        // keep their original provenance; contributing events are traced via
        // their VisionEventReview rows instead. The line's vlmReviewId stays
        // NULL by design: line → visionEventId → event → review is the
        // canonical chain (the review row does not exist yet at line-write
        // time, and review rows are append-only). The declared sourceType is
        // copied verbatim — a DEVICE/ADMIN/SYSTEM event must not masquerade
        // as VISION provenance on the line or the order.
        const lineEvidence = {
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          evidenceBundleId: event.evidenceBundleId,
          visionEventId: event.id,
          evidenceScore: event.evidenceScore,
          evidenceQuality: event.evidenceQuality,
          reasonCodes:
            input.decision === VisionReviewDecision.OVERRIDE
              ? [...event.reasonCodes, 'manual-override']
              : event.reasonCodes,
        };

        if (event.type === VisionEventType.PRODUCT_RETURN) {
          // A return decrements what is actually in the basket; the product
          // does not need to be saleable (or even still exist as ACTIVE) to
          // be handed back. For OVERRIDE the reviewer-chosen product must at
          // least exist in the tenant, so a typo is a controlled 404.
          if (input.decision === VisionReviewDecision.OVERRIDE) {
            const product = await tx.product.findFirst({
              where: { id: appliedProductId, tenantId: scopedTenantId },
              select: { id: true },
            });
            if (!product) {
              return 'product-not-found' as const;
            }
          }
          const line = await tx.checkoutSessionLine.findFirst({
            where: {
              tenantId: scopedTenantId,
              sessionId: event.sessionId,
              productId: appliedProductId,
              status: CheckoutSessionLineStatus.ACTIVE,
            },
          });
          if (!line) {
            return 'no-line-to-decrement' as const;
          }
          // A return can never take back more than the line actually holds:
          // clamp to the line quantity so the immutable review's
          // appliedQuantity records what was truly applied to the basket,
          // never the (larger) claimed value.
          if (appliedQuantity > line.quantity) {
            appliedQuantity = line.quantity;
          }
          const remaining = line.quantity - appliedQuantity;
          if (remaining >= 1) {
            // Only the quantity changes: the surviving units keep the
            // provenance of the event that ADDED them (checkout completion
            // copies line lineage onto order lines). The return itself is
            // fully recorded by the VisionEventReview row (eventId →
            // sessionLineId) and the line-changed audit entry.
            const after = await tx.checkoutSessionLine.update({
              where: {
                id_tenantId: { id: line.id, tenantId: scopedTenantId },
              },
              data: { quantity: remaining },
            });
            basketEffect = VisionBasketEffect.LINE_DECREASED;
            sessionLineId = after.id;
            lineAudit = builders.lineChanged(line, after);
          } else {
            // Returning at least everything on the line: SOFT delete, same
            // tombstone semantics as checkout line removal (idempotency
            // reservations survive; REMOVED lines never complete).
            const removed = await tx.checkoutSessionLine.update({
              where: {
                id_tenantId: { id: line.id, tenantId: scopedTenantId },
              },
              data: {
                status: CheckoutSessionLineStatus.REMOVED,
                removedAt: new Date(),
                ...lineEvidence,
              },
            });
            basketEffect = VisionBasketEffect.LINE_REMOVED;
            sessionLineId = removed.id;
            lineAudit = builders.lineRemoved(line);
          }
        } else {
          // PRODUCT_PICKUP / CART_INSERTION add to the basket. Serialize
          // with ProductsRepository.update() (same key) BEFORE reading the
          // product, held through the write — mirrors checkout addLine so
          // status/UOM cannot change between the read and the line write.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
            scopedTenantId,
            appliedProductId,
          )}))`;
          const product = await tx.product.findFirst({
            where: { id: appliedProductId, tenantId: scopedTenantId },
            select: {
              id: true,
              sku: true,
              name: true,
              unitOfMeasure: true,
              status: true,
            },
          });
          if (!product) {
            return 'product-not-found' as const;
          }
          if (product.status !== ProductStatus.ACTIVE) {
            return 'product-not-saleable' as const;
          }
          const existing = await tx.checkoutSessionLine.findFirst({
            where: {
              tenantId: scopedTenantId,
              sessionId: event.sessionId,
              productId: appliedProductId,
              status: CheckoutSessionLineStatus.ACTIVE,
            },
          });
          if (existing) {
            const total = existing.quantity + appliedQuantity;
            // The DTO bounds each quantity individually, but the SUM can
            // exceed the INTEGER column — reject as a controlled conflict
            // instead of a raw Prisma range error.
            if (total > PG_INT_MAX) {
              return 'line-quantity-overflow' as const;
            }
            // ONLY the quantity changes on aggregation: the line keeps the
            // provenance of the event that CREATED it (completion copies
            // line lineage onto order lines, and rewriting it would falsely
            // attribute the earlier units to this event). Every contributing
            // event stays traceable via its VisionEventReview row
            // (eventId → sessionLineId) and the line-changed audit entry.
            const after = await tx.checkoutSessionLine.update({
              where: {
                id_tenantId: { id: existing.id, tenantId: scopedTenantId },
              },
              data: { quantity: total },
            });
            basketEffect = VisionBasketEffect.LINE_INCREASED;
            sessionLineId = after.id;
            lineAudit = builders.lineChanged(existing, after);
          } else {
            const line = await tx.checkoutSessionLine.create({
              data: {
                tenantId: scopedTenantId,
                sessionId: event.sessionId,
                productId: product.id,
                // Snapshot at apply time: later catalog edits must not
                // rewrite what entered the basket.
                sku: product.sku,
                productName: product.name,
                unitOfMeasure: product.unitOfMeasure,
                quantity: appliedQuantity,
                createdById: input.reviewedById,
                ...lineEvidence,
              },
            });
            basketEffect = VisionBasketEffect.LINE_ADDED;
            sessionLineId = line.id;
            lineAudit = builders.lineAdded(line);
          }
        }
      }

      const review = await tx.visionEventReview.create({
        data: {
          tenantId: scopedTenantId,
          eventId: event.id,
          decision: input.decision,
          reason: input.reason,
          appliedProductId,
          appliedQuantity,
          basketEffect,
          sessionLineId,
          reviewedById: input.reviewedById,
        },
      });
      const after = await tx.visionEvent.update({
        where: { id_tenantId: { id: event.id, tenantId: scopedTenantId } },
        data: {
          status:
            input.decision === VisionReviewDecision.REJECT
              ? VisionEventStatus.REJECTED
              : input.decision === VisionReviewDecision.OVERRIDE
                ? VisionEventStatus.OVERRIDDEN
                : VisionEventStatus.APPROVED,
        },
        include: VISION_EVENT_DETAIL_INCLUDE,
      });
      if (lineAudit) {
        await this.auditLog.record(lineAudit, tx);
      }
      await this.auditLog.record(builders.reviewCreated(review), tx);
      await this.auditLog.record(builders.decided(event, after), tx);
      return after;
    });
  }

  /**
   * Binds a still-unbound PENDING_REVIEW event to a checkout session — the
   * audited correlation step for events ingested BEFORE the shopper's
   * session was known. Binding is one-shot (an already-bound event never
   * rebinds; correcting a wrong binding is a REJECT + re-ingest) and never
   * touches the basket: only a subsequent approval does.
   *
   * Runs under the vision-event advisory lock so a bind cannot interleave
   * with a concurrent decision on the same event; the same session-unit
   * check as ingest keeps one unit's event from ever mutating another
   * unit's basket later.
   */
  bindSession(
    tenantId: string,
    eventId: string,
    sessionId: string,
    buildAuditEntry: (
      before: VisionEvent,
      after: VisionEventDetail,
    ) => AuditEntry,
  ): Promise<VisionEventDetail | BindSessionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${visionEventAdvisoryLockKey(
        scopedTenantId,
        eventId,
      )}))`;
      const event = await tx.visionEvent.findFirst({
        where: { id: eventId, tenantId: scopedTenantId },
      });
      if (!event) {
        return null;
      }
      if (event.status !== VisionEventStatus.PENDING_REVIEW) {
        return 'already-decided' as const;
      }
      if (event.sessionId) {
        return 'already-bound' as const;
      }
      const session = await tx.checkoutSession.findFirst({
        where: { id: sessionId, tenantId: scopedTenantId },
        select: { id: true, unitId: true, locationId: true },
      });
      if (!session) {
        return 'session-not-found' as const;
      }
      // Same rule as ingest: an event bound to a session at a DIFFERENT
      // unit would let one shopper's camera event mutate another unit's
      // basket on approval. Session status is deliberately NOT checked —
      // approval enforces basket mutability, binding only records the
      // correlation.
      if (session.unitId !== event.unitId) {
        return 'session-unit-mismatch' as const;
      }
      // And the STORE must match: a relocated unit's old-store session must
      // not accept events from its new store (or vice versa).
      if (session.locationId !== event.locationId) {
        return 'session-location-mismatch' as const;
      }
      // Conditional write (sessionId IS NULL): checkout mutations CLAIM
      // cited unbound events with the same compare-and-set WITHOUT taking
      // the vision-event advisory lock, so an unconditional update here
      // could stomp a concurrent claim. Losing the race is 'already-bound'.
      const bound = await tx.visionEvent.updateMany({
        where: {
          id: event.id,
          tenantId: scopedTenantId,
          sessionId: null,
        },
        data: { sessionId },
      });
      if (bound.count === 0) {
        return 'already-bound' as const;
      }
      const after = await tx.visionEvent.findFirstOrThrow({
        where: { id: event.id, tenantId: scopedTenantId },
        include: VISION_EVENT_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(event, after), tx);
      return after;
    });
  }
}
