import { Injectable } from '@nestjs/common';
import {
  CheckoutSession,
  CheckoutSessionLine,
  CheckoutSessionLineStatus,
  CheckoutSessionStatus,
  EvidenceQuality,
  EvidenceSourceType,
  InventoryLevel,
  InventoryMovement,
  InventoryMovementType,
  OrderStatus,
  Prisma,
  ProductStatus,
  VisionEventStatus,
} from '@prisma/client';
import { BASKET_AFFECTING_EVENT_TYPES } from '../common/vision-event-policy';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PG_INT_MAX } from '../common/integer-bounds';
import {
  checkoutSessionAdvisoryLockKey,
  deviceAdvisoryLockKey,
  productStockAdvisoryLockKey,
  tenantOrderNumberAdvisoryLockKey,
  unitAdvisoryLockKey,
} from '../common/locks';
import {
  AdjustmentFailure,
  AdjustmentRejected,
  InventoryRepository,
} from '../inventory/inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

/** Read shape for session list responses (no lines — keep pages light). */
export const SESSION_INCLUDE = {
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
} satisfies Prisma.CheckoutSessionInclude;

/**
 * Read shape for session detail: ACTIVE basket lines in deterministic order
 * (REMOVED tombstones are idempotency reservations, never basket content)
 * plus a minimal order reference so a completed session links to its order.
 */
export const SESSION_DETAIL_INCLUDE = {
  ...SESSION_INCLUDE,
  lines: {
    where: { status: CheckoutSessionLineStatus.ACTIVE },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  order: { select: { id: true, orderNumber: true, status: true } },
} satisfies Prisma.CheckoutSessionInclude;

export type CheckoutSessionWithRefs = Prisma.CheckoutSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

export type CheckoutSessionDetail = Prisma.CheckoutSessionGetPayload<{
  include: typeof SESSION_DETAIL_INCLUDE;
}>;

/** Read shape for the order returned by completion (mirrors OrdersRepository). */
export const COMPLETION_ORDER_INCLUDE = {
  lines: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  location: { select: { id: true, name: true, code: true } },
  unit: { select: { id: true, name: true, code: true } },
} satisfies Prisma.OrderInclude;

export type CompletedOrder = Prisma.OrderGetPayload<{
  include: typeof COMPLETION_ORDER_INCLUDE;
}>;

/**
 * The session lifecycle state machine. OPEN is the entry state; COMPLETED is
 * only reachable through complete() (it consumes inventory and creates an
 * order, never a plain status write). COMPLETED, CANCELLED, and EXPIRED are
 * terminal: nothing about a terminal session may change again.
 */
export const SESSION_STATUS_TRANSITIONS: Readonly<
  Record<CheckoutSessionStatus, readonly CheckoutSessionStatus[]>
> = {
  [CheckoutSessionStatus.OPEN]: [
    CheckoutSessionStatus.ACTIVE,
    CheckoutSessionStatus.PENDING_REVIEW,
    CheckoutSessionStatus.CANCELLED,
    CheckoutSessionStatus.EXPIRED,
  ],
  [CheckoutSessionStatus.ACTIVE]: [
    CheckoutSessionStatus.PENDING_REVIEW,
    CheckoutSessionStatus.CANCELLED,
    CheckoutSessionStatus.EXPIRED,
  ],
  [CheckoutSessionStatus.PENDING_REVIEW]: [
    CheckoutSessionStatus.ACTIVE,
    CheckoutSessionStatus.CANCELLED,
    CheckoutSessionStatus.EXPIRED,
  ],
  [CheckoutSessionStatus.COMPLETED]: [],
  [CheckoutSessionStatus.CANCELLED]: [],
  [CheckoutSessionStatus.EXPIRED]: [],
};

/** States in which the basket may still be mutated and completion may run. */
export const MUTABLE_SESSION_STATUSES: readonly CheckoutSessionStatus[] = [
  CheckoutSessionStatus.OPEN,
  CheckoutSessionStatus.ACTIVE,
  CheckoutSessionStatus.PENDING_REVIEW,
];

const TERMINAL_ENDED_STATUSES: readonly CheckoutSessionStatus[] = [
  CheckoutSessionStatus.CANCELLED,
  CheckoutSessionStatus.EXPIRED,
];

/** Vendor-neutral evidence/source lineage carried by every basket mutation. */
export interface EvidenceRefs {
  sourceType?: EvidenceSourceType;
  sourceId?: string;
  evidenceBundleId?: string;
  visionEventId?: string;
  vlmReviewId?: string;
  evidenceScore?: number;
  evidenceQuality?: EvidenceQuality;
  reasonCodes?: string[];
}

/**
 * A caller-supplied evidence lineage reference that does not resolve to a
 * row of the SAME tenant. Lineage refs are canonical (checkout completion
 * copies them onto order lines), so an unresolvable or cross-tenant id must
 * be rejected, never persisted.
 */
export type EvidenceRefRejection =
  | 'evidence-bundle-not-found'
  | 'vision-event-not-found'
  | 'vision-event-session-mismatch'
  | 'vision-event-unit-mismatch'
  | 'vision-event-location-mismatch'
  | 'vision-event-decided'
  | 'vision-event-pending-review'
  | 'vision-event-already-applied'
  | 'evidence-bundle-event-mismatch';

export type CreateSessionRejection =
  | 'location-not-found'
  | 'unit-not-found'
  | 'unit-location-mismatch'
  | 'device-not-found'
  | 'device-unit-mismatch'
  | EvidenceRefRejection;

export type StatusUpdateRejection = 'terminal-blocked' | 'transition-blocked';

export type LineMutationRejection =
  | 'session-not-found'
  | 'session-terminal'
  | 'product-not-found'
  | 'product-not-saleable'
  | 'line-not-found'
  | 'idempotency-key-consumed'
  | EvidenceRefRejection;

export type CompletionRejection =
  | 'session-not-found'
  | 'session-terminal'
  | 'already-completed'
  | 'empty-session'
  | 'idempotency-key-conflict'
  | 'total-quantity-overflow';

/** A per-line inventory decrement failure that aborted the whole completion. */
export interface CompletionStockFailure {
  stockFailure: AdjustmentFailure;
  sku: string;
}

export interface CompletionAuditBuilders {
  sessionCompleted: (
    before: CheckoutSession,
    after: CheckoutSession,
  ) => AuditEntry;
  orderCreated: (order: CompletedOrder) => AuditEntry;
  stockConsumed: (
    movement: InventoryMovement,
    level: InventoryLevel,
    line: CheckoutSessionLine,
  ) => AuditEntry;
}

/**
 * Thrown INSIDE the completion transaction when a line's inventory decrement
 * is rejected, so the whole completion (order, lines, movements, session
 * flip) rolls back together. Caught at the transaction boundary and mapped
 * to a CompletionStockFailure sentinel carrying the offending SKU.
 */
class CompletionStockRejected extends Error {
  constructor(
    readonly failure: AdjustmentFailure,
    readonly sku: string,
  ) {
    super(`${failure}: ${sku}`);
    this.name = 'CompletionStockRejected';
  }
}

/**
 * Thrown INSIDE a mutation transaction when an evidence-lineage check fails
 * AFTER a write has already happened (the session-create claim), so the
 * whole transaction rolls back. Caught at the transaction boundary and
 * mapped to the rejection sentinel.
 */
class EvidenceRefRejected extends Error {
  constructor(readonly rejection: EvidenceRefRejection) {
    super(rejection);
    this.name = 'EvidenceRefRejected';
  }
}

function formatOrderNumber(sequence: number): string {
  return `ORD-${String(sequence).padStart(6, '0')}`;
}

@Injectable()
export class CheckoutSessionsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly inventoryRepository: InventoryRepository,
  ) {
    super(prisma);
  }

  /**
   * Opens a session after tenant-scoped reference checks. All checks run
   * inside the insert transaction (with the composite same-tenant FKs in
   * migration SQL as the backstop), so a reference from another tenant is
   * simply "not found" and can never race its way in.
   */
  create(
    tenantId: string,
    data: EvidenceRefs & {
      locationId: string;
      unitId: string;
      deviceId?: string;
      idempotencyKey?: string;
      createdById?: string;
    },
    buildAuditEntry: (session: CheckoutSessionDetail) => AuditEntry,
    buildEventClaimedAudit?: (eventId: string, sessionId: string) => AuditEntry,
  ): Promise<
    | { session: CheckoutSessionDetail; replayed: boolean }
    | CreateSessionRejection
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    const run = this.prisma.$transaction(async (tx) => {
      // Idempotent replay: the same key returns the original session
      // untouched — no duplicate, no audit row, no field merging.
      if (data.idempotencyKey) {
        const existing = await tx.checkoutSession.findFirst({
          where: {
            tenantId: scopedTenantId,
            idempotencyKey: data.idempotencyKey,
          },
          include: SESSION_DETAIL_INCLUDE,
        });
        if (existing) {
          return { session: existing, replayed: true };
        }
      }
      // Serialize with UnitsRepository.update()/delete() (same key), held
      // through the insert: the unit/store validation below must not pass on
      // a read that a concurrent unit mutation immediately invalidates,
      // or the session would persist a stale unit→store binding. Taken
      // BEFORE the device lock: this is the ONLY path that holds both the
      // unit and device locks, and it always acquires them unit-then-device,
      // so no lock-ordering cycle exists (every other path — units, device
      // update/delete/heartbeat, device create — takes at most one of the
      // two). Concurrent session creates therefore cannot deadlock.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${unitAdvisoryLockKey(
        scopedTenantId,
        data.unitId,
      )}))::text`;
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
      // A unit from the right tenant but the wrong store would silently
      // decouple the session's store from where its inventory is consumed.
      if (unit.locationId !== data.locationId) {
        return 'unit-location-mismatch' as const;
      }
      if (data.deviceId) {
        // Serialize with DevicesRepository.update() (same key), held through
        // the insert: a concurrent device reassignment to another unit must
        // not land between the unit check below and the session row, or the
        // session would bind a source device that was no longer attached to
        // the selected unit at creation time.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceAdvisoryLockKey(
          scopedTenantId,
          data.deviceId,
        )}))::text`;
        const device = await tx.device.findFirst({
          where: { id: data.deviceId, tenantId: scopedTenantId },
          select: { id: true, unitId: true },
        });
        if (!device) {
          return 'device-not-found' as const;
        }
        // The source device must be the hardware attached to the SELECTED
        // unit: a same-tenant device from another unit would corrupt the
        // evidence/source lineage every future edge flow trusts.
        if (device.unitId !== data.unitId) {
          return 'device-unit-mismatch' as const;
        }
      }
      const refRejection = await this.validateEvidenceRefs(
        tx,
        scopedTenantId,
        data,
        { unitId: data.unitId, locationId: data.locationId },
        'session',
      );
      if (refRejection) {
        return refRejection;
      }
      const session = await tx.checkoutSession.create({
        data: {
          tenantId: scopedTenantId,
          locationId: data.locationId,
          unitId: data.unitId,
          deviceId: data.deviceId,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
          evidenceBundleId: data.evidenceBundleId,
          visionEventId: data.visionEventId,
          vlmReviewId: data.vlmReviewId,
          evidenceScore: data.evidenceScore,
          evidenceQuality: data.evidenceQuality,
          reasonCodes: data.reasonCodes,
          idempotencyKey: data.idempotencyKey,
          createdById: data.createdById,
        },
        include: SESSION_DETAIL_INCLUDE,
      });
      // The cited event is claimed for the NEW session (the id exists only
      // now). A lost race against a concurrent bind throws, rolling the
      // session insert back with it.
      if (data.visionEventId !== undefined) {
        const claimRejection = await this.claimVisionEvent(
          tx,
          scopedTenantId,
          data.visionEventId,
          session.id,
          buildEventClaimedAudit,
        );
        if (claimRejection) {
          throw new EvidenceRefRejected(claimRejection);
        }
      }
      await this.auditLog.record(buildAuditEntry(session), tx);
      return { session, replayed: false };
    });
    return run.catch((error: unknown) => {
      if (error instanceof EvidenceRefRejected) {
        return error.rejection;
      }
      throw error;
    });
  }

  /** Replay lookup for the create P2002 race (two firsts, same key). */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CheckoutSessionDetail | null> {
    return this.prisma.checkoutSession.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
      include: SESSION_DETAIL_INCLUDE,
    });
  }

  /**
   * Replay lookup for the completion P2002 backstop: if a completion loses
   * the (tenantId, idempotencyKey) unique race despite the under-lock
   * recheck, the service resolves the winning order here and maps to a
   * replay (same session) or a controlled 409 (different session) — never
   * an uncaught 500.
   */
  findOrderByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CompletedOrder | null> {
    return this.prisma.order.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
      include: COMPLETION_ORDER_INCLUDE,
    });
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<CheckoutSessionDetail | null> {
    return this.prisma.checkoutSession.findFirst({
      where: this.scope(tenantId, { id }),
      include: SESSION_DETAIL_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: {
      status?: CheckoutSessionStatus;
      locationId?: string;
      unitId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: CheckoutSessionWithRefs[]; total: number }> {
    const where: Prisma.CheckoutSessionWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.locationId) {
      where.locationId = filters.locationId;
    }
    if (filters.unitId) {
      where.unitId = filters.unitId;
    }
    const [items, total] = await Promise.all([
      this.prisma.checkoutSession.findMany({
        where,
        include: SESSION_INCLUDE,
        // id is the deterministic tie-breaker: startedAt is millisecond
        // precision, so concurrent sessions could otherwise reorder across
        // skip/take pages.
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.checkoutSession.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Lifecycle transition (everything except COMPLETED — see complete()).
   * Runs under the session advisory lock so a transition cannot interleave
   * with a line mutation or completion deciding on a stale status.
   */
  updateStatus(
    tenantId: string,
    id: string,
    target: CheckoutSessionStatus,
    buildAuditEntry: (
      before: CheckoutSession,
      after: CheckoutSessionDetail,
    ) => AuditEntry,
  ): Promise<CheckoutSessionDetail | StatusUpdateRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSession(tx, scopedTenantId, id);
      const before = await tx.checkoutSession.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      // Terminal protection first: a COMPLETED/CANCELLED/EXPIRED session
      // never changes again, whatever the requested target.
      if (SESSION_STATUS_TRANSITIONS[before.status].length === 0) {
        return 'terminal-blocked' as const;
      }
      if (!SESSION_STATUS_TRANSITIONS[before.status].includes(target)) {
        return 'transition-blocked' as const;
      }
      const after = await tx.checkoutSession.update({
        where: { id: before.id },
        data: {
          status: target,
          endedAt: TERMINAL_ENDED_STATUSES.includes(target)
            ? new Date()
            : undefined,
        },
        include: SESSION_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  /**
   * Adds a basket line. The product is resolved INSIDE the transaction so
   * the snapshot (sku/name/unit) is taken from the row the FK will point at,
   * and only ACTIVE products are saleable.
   */
  addLine(
    tenantId: string,
    sessionId: string,
    data: EvidenceRefs & {
      productId: string;
      quantity: number;
      idempotencyKey?: string;
      createdById?: string;
    },
    buildAuditEntry: (line: CheckoutSessionLine) => AuditEntry,
    buildEventClaimedAudit?: (eventId: string, sessionId: string) => AuditEntry,
  ): Promise<
    { line: CheckoutSessionLine; replayed: boolean } | LineMutationRejection
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSession(tx, scopedTenantId, sessionId);
      const session = await tx.checkoutSession.findFirst({
        where: { id: sessionId, tenantId: scopedTenantId },
        select: { id: true, status: true, unitId: true, locationId: true },
      });
      if (!session) {
        return 'session-not-found' as const;
      }
      if (!MUTABLE_SESSION_STATUSES.includes(session.status)) {
        return 'session-terminal' as const;
      }
      if (data.idempotencyKey) {
        const existing = await tx.checkoutSessionLine.findFirst({
          where: {
            tenantId: scopedTenantId,
            idempotencyKey: data.idempotencyKey,
          },
        });
        if (existing && existing.sessionId === sessionId) {
          // The key landed on a REMOVED tombstone: the original add
          // succeeded and the line was then intentionally removed. A retry
          // must NOT resurrect the item — the key is consumed for good.
          if (existing.status === CheckoutSessionLineStatus.REMOVED) {
            return 'idempotency-key-consumed' as const;
          }
          // Only a replay against the SAME session is a replay; the same key
          // pointed at another session is a caller bug surfaced as P2002.
          return { line: existing, replayed: true };
        }
      }
      // Serialize with ProductsRepository.update() (same key) BEFORE reading
      // the product, held through the line insert: without it, status/UOM
      // could change between this read and the create, persisting a
      // non-saleable or stale-UOM basket line that completion only rejects
      // later. Lock order here is session→product; completion is
      // session→order-number→product; no path takes product before session,
      // so the two cannot deadlock.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${productStockAdvisoryLockKey(
        scopedTenantId,
        data.productId,
      )}))::text`;
      const product = await tx.product.findFirst({
        where: { id: data.productId, tenantId: scopedTenantId },
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
      const refRejection = await this.validateEvidenceRefs(
        tx,
        scopedTenantId,
        data,
        {
          sessionId,
          unitId: session.unitId,
          locationId: session.locationId,
        },
        'line',
      );
      if (refRejection) {
        return refRejection;
      }
      // Claim an unbound cited event for THIS session before writing the
      // line, so no later bind can point it at another session. Nothing has
      // been written yet, so a lost claim race is a plain rejection.
      if (data.visionEventId !== undefined) {
        const claimRejection = await this.claimVisionEvent(
          tx,
          scopedTenantId,
          data.visionEventId,
          sessionId,
          buildEventClaimedAudit,
        );
        if (claimRejection) {
          return claimRejection;
        }
      }
      const line = await tx.checkoutSessionLine.create({
        data: {
          tenantId: scopedTenantId,
          sessionId,
          productId: product.id,
          // Snapshot at add time: later catalog edits must not rewrite what
          // was in the basket.
          sku: product.sku,
          productName: product.name,
          unitOfMeasure: product.unitOfMeasure,
          quantity: data.quantity,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
          evidenceBundleId: data.evidenceBundleId,
          visionEventId: data.visionEventId,
          vlmReviewId: data.vlmReviewId,
          evidenceScore: data.evidenceScore,
          evidenceQuality: data.evidenceQuality,
          reasonCodes: data.reasonCodes,
          idempotencyKey: data.idempotencyKey,
          createdById: data.createdById,
        },
      });
      await this.auditLog.record(buildAuditEntry(line), tx);
      return { line, replayed: false };
    });
  }

  updateLine(
    tenantId: string,
    sessionId: string,
    lineId: string,
    data: EvidenceRefs & { quantity?: number },
    buildAuditEntry: (
      before: CheckoutSessionLine,
      after: CheckoutSessionLine,
    ) => AuditEntry,
    buildEventClaimedAudit?: (eventId: string, sessionId: string) => AuditEntry,
  ): Promise<CheckoutSessionLine | LineMutationRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSession(tx, scopedTenantId, sessionId);
      const session = await tx.checkoutSession.findFirst({
        where: { id: sessionId, tenantId: scopedTenantId },
        select: { id: true, status: true, unitId: true, locationId: true },
      });
      if (!session) {
        return 'session-not-found' as const;
      }
      if (!MUTABLE_SESSION_STATUSES.includes(session.status)) {
        return 'session-terminal' as const;
      }
      const before = await tx.checkoutSessionLine.findFirst({
        // A REMOVED tombstone is not part of the basket: updating it would
        // resurrect it through the back door.
        where: {
          id: lineId,
          sessionId,
          tenantId: scopedTenantId,
          status: CheckoutSessionLineStatus.ACTIVE,
        },
      });
      if (!before) {
        return 'line-not-found' as const;
      }
      // Validate the EFFECTIVE post-update lineage, not just the patched
      // fields: a patch supplying only a bundle (or only an event) must be
      // checked against the reference the line KEEPS, or a mismatched
      // event/bundle pair would persist and flow onto the order line.
      const effectiveRefs: EvidenceRefs = {
        evidenceBundleId:
          data.evidenceBundleId ?? before.evidenceBundleId ?? undefined,
        visionEventId:
          data.visionEventId ?? before.visionEventId ?? undefined,
      };
      const refRejection = await this.validateEvidenceRefs(
        tx,
        scopedTenantId,
        effectiveRefs,
        {
          sessionId,
          unitId: session.unitId,
          locationId: session.locationId,
        },
        'line',
        // The reference the line already carries stays citable (a decided
        // event's review may have created this very line); only NEWLY
        // asserted basket-affecting lineage is rejected.
        before.visionEventId ?? undefined,
      );
      if (refRejection) {
        return refRejection;
      }
      if (effectiveRefs.visionEventId !== undefined) {
        const claimRejection = await this.claimVisionEvent(
          tx,
          scopedTenantId,
          effectiveRefs.visionEventId,
          sessionId,
          buildEventClaimedAudit,
        );
        if (claimRejection) {
          return claimRejection;
        }
      }
      const after = await tx.checkoutSessionLine.update({
        where: { id: before.id },
        data: {
          quantity: data.quantity,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
          evidenceBundleId: data.evidenceBundleId,
          visionEventId: data.visionEventId,
          vlmReviewId: data.vlmReviewId,
          evidenceScore: data.evidenceScore,
          evidenceQuality: data.evidenceQuality,
          reasonCodes: data.reasonCodes,
        },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  removeLine(
    tenantId: string,
    sessionId: string,
    lineId: string,
    buildAuditEntry: (deleted: CheckoutSessionLine) => AuditEntry,
  ): Promise<CheckoutSessionLine | LineMutationRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSession(tx, scopedTenantId, sessionId);
      const session = await tx.checkoutSession.findFirst({
        where: { id: sessionId, tenantId: scopedTenantId },
        select: { id: true, status: true },
      });
      if (!session) {
        return 'session-not-found' as const;
      }
      if (!MUTABLE_SESSION_STATUSES.includes(session.status)) {
        return 'session-terminal' as const;
      }
      const existing = await tx.checkoutSessionLine.findFirst({
        where: {
          id: lineId,
          sessionId,
          tenantId: scopedTenantId,
          status: CheckoutSessionLineStatus.ACTIVE,
        },
      });
      if (!existing) {
        return 'line-not-found' as const;
      }
      // SOFT delete: the tombstone keeps the (tenantId, idempotencyKey)
      // reservation alive, so a lost-response retry of the original add can
      // never resurrect an intentionally removed item. REMOVED lines are
      // excluded from the active basket and from completion.
      const removed = await tx.checkoutSessionLine.update({
        where: { id: existing.id },
        data: {
          status: CheckoutSessionLineStatus.REMOVED,
          removedAt: new Date(),
        },
      });
      await this.auditLog.record(buildAuditEntry(existing), tx);
      return removed;
    });
  }

  /**
   * Completes a session into a CONFIRMED order, consuming inventory — the
   * Phase 5 core invariant lives here: the order, its lines, every SALE
   * movement, the level decrements, the session flip, and all audit rows
   * commit or roll back as ONE transaction. A failed decrement (insufficient
   * stock) can therefore never leave a confirmed order or a partial ledger
   * behind.
   *
   * Duplicate-completion safety, in layers:
   * - the session advisory lock serializes concurrent completion attempts;
   * - a COMPLETED session replays (same idempotency key) or rejects;
   * - the per-tenant (tenantId, idempotencyKey) unique on Order backstops
   *   the replay lookup;
   * - the (tenantId, checkoutSessionId) unique makes a second order for the
   *   same session impossible even if all of the above raced.
   */
  complete(
    tenantId: string,
    sessionId: string,
    input: { idempotencyKey?: string; createdById?: string },
    builders: CompletionAuditBuilders,
  ): Promise<
    | { order: CompletedOrder; replayed: boolean }
    | CompletionRejection
    | CompletionStockFailure
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma
      .$transaction(async (tx) => {
        await this.lockSession(tx, scopedTenantId, sessionId);
        const session = await tx.checkoutSession.findFirst({
          where: { id: sessionId, tenantId: scopedTenantId },
          include: {
            // Only ACTIVE lines complete into an order; REMOVED tombstones
            // are idempotency reservations and must never consume stock.
            lines: {
              where: { status: CheckoutSessionLineStatus.ACTIVE },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        });
        if (!session) {
          return 'session-not-found' as const;
        }
        if (session.status === CheckoutSessionStatus.COMPLETED) {
          // Idempotent replay of an already-finished completion: same key →
          // same order, no new writes of any kind.
          if (input.idempotencyKey) {
            const existingOrder = await tx.order.findFirst({
              where: {
                tenantId: scopedTenantId,
                checkoutSessionId: session.id,
                idempotencyKey: input.idempotencyKey,
              },
              include: COMPLETION_ORDER_INCLUDE,
            });
            if (existingOrder) {
              return { order: existingOrder, replayed: true };
            }
          }
          return 'already-completed' as const;
        }
        if (!MUTABLE_SESSION_STATUSES.includes(session.status)) {
          return 'session-terminal' as const;
        }
        if (session.lines.length === 0) {
          return 'empty-session' as const;
        }
        // Idempotency-key guard: a key that already produced an order either
        // replays it (same session — the retry of a completion whose
        // response was lost) or is a controlled conflict (a DIFFERENT
        // session reusing the key must never receive another session's
        // order, nor blow up as an uncaught unique violation).
        const checkIdempotencyKey = async () => {
          if (!input.idempotencyKey) {
            return null;
          }
          const existing = await tx.order.findFirst({
            where: {
              tenantId: scopedTenantId,
              idempotencyKey: input.idempotencyKey,
            },
            include: COMPLETION_ORDER_INCLUDE,
          });
          if (!existing) {
            return null;
          }
          return existing.checkoutSessionId === session.id
            ? ({ order: existing, replayed: true } as const)
            : ('idempotency-key-conflict' as const);
        };
        const preLock = await checkIdempotencyKey();
        if (preLock) {
          return preLock;
        }

        // Order numbers are per-tenant sequential; the advisory lock
        // serializes assignment so two simultaneous completions cannot
        // observe the same count. Orders are never deleted (cancel is a
        // status), so count+1 is free — the probe loop only steps over
        // gaps left by out-of-band data surgery.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantOrderNumberAdvisoryLockKey(
          scopedTenantId,
        )}))::text`;

        // Recheck the key now that the tenant order lock is held: two
        // completions with the same key on DIFFERENT sessions serialize
        // here, so the loser sees the winner's committed order and returns
        // a controlled replay/conflict instead of racing into the
        // (tenantId, idempotencyKey) unique as a P2002/500.
        const underLock = await checkIdempotencyKey();
        if (underLock) {
          return underLock;
        }
        const count = await tx.order.count({
          where: { tenantId: scopedTenantId },
        });
        let sequence = count + 1;
        while (
          await tx.order.findFirst({
            where: {
              tenantId: scopedTenantId,
              orderNumber: formatOrderNumber(sequence),
            },
            select: { id: true },
          })
        ) {
          sequence += 1;
        }
        const orderNumber = formatOrderNumber(sequence);
        const now = new Date();
        const totalQuantity = session.lines.reduce(
          (sum, line) => sum + line.quantity,
          0,
        );
        // Each line quantity is individually ≤ PG_INT_MAX (DTO bound), but the
        // SUM can exceed the INTEGER backing Order.totalQuantity. Reject BEFORE
        // order.create so an API-valid-but-oversized basket becomes a controlled
        // rejection instead of a raw out-of-range Prisma error (500). No order,
        // lines, movements, session flip, or audit rows are written on this
        // path — the transaction has only taken locks and read so far.
        if (totalQuantity > PG_INT_MAX) {
          return 'total-quantity-overflow' as const;
        }

        // The order row is created first so SALE movements can carry its id
        // as their referenceType/referenceId cause. CONFIRMED means
        // "inventory consumed" — it carries NO paid/captured semantics
        // (pricing/payment fields stay null until their own phases).
        const order = await tx.order.create({
          data: {
            tenantId: scopedTenantId,
            orderNumber,
            checkoutSessionId: session.id,
            locationId: session.locationId,
            unitId: session.unitId,
            status: OrderStatus.CONFIRMED,
            confirmedAt: now,
            placedAt: now,
            totalQuantity,
            sourceType: session.sourceType,
            sourceId: session.sourceId,
            evidenceBundleId: session.evidenceBundleId,
            visionEventId: session.visionEventId,
            // Pre-Phase-7 opaque refs travel in their own columns — they
            // are NEVER promoted to the canonical Phase 7 references.
            externalVisionEventRef: session.externalVisionEventRef,
            externalEvidenceBundleRef: session.externalEvidenceBundleRef,
            vlmReviewId: session.vlmReviewId,
            evidenceScore: session.evidenceScore,
            evidenceQuality: session.evidenceQuality,
            reasonCodes: session.reasonCodes,
            idempotencyKey: input.idempotencyKey,
            createdById: input.createdById,
          },
        });

        // Decrement stock line by line IN productId ORDER: every concurrent
        // multi-product completion locks products in the same sequence, so
        // two completions sharing products cannot deadlock. applyMovement
        // throws AdjustmentRejected on insufficient stock, aborting the
        // whole completion.
        const sortedLines = [...session.lines].sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
        );
        for (const line of sortedLines) {
          try {
            const { movement, level } =
              await this.inventoryRepository.applyMovement(tx, {
                tenantId: scopedTenantId,
                locationId: session.locationId,
                productId: line.productId,
                quantityDelta: -line.quantity,
                movementType: InventoryMovementType.SALE,
                // Revalidated against the CURRENT product under the
                // per-product lock: the line quantity was captured in the
                // snapshot unit, so a UOM change since add rejects the
                // completion instead of corrupting the SALE ledger.
                expectedUnitOfMeasure: line.unitOfMeasure,
                reason: `Checkout completion ${orderNumber}`,
                referenceType: 'Order',
                referenceId: order.id,
                createdById: input.createdById,
              });
            await this.auditLog.record(
              builders.stockConsumed(movement, level, line),
              tx,
            );
          } catch (error) {
            if (error instanceof AdjustmentRejected) {
              // Re-thrown with the offending SKU so the 409 can name it;
              // throwing (not returning) is what rolls everything back.
              throw new CompletionStockRejected(error.reason, line.sku);
            }
            throw error;
          }
        }

        // Order lines snapshot the SESSION lines (what the shopper actually
        // had), not the live product rows, and keep the sessionLineId back
        // reference so the session → basket line → order line → movement
        // chain stays traceable.
        for (const line of session.lines) {
          await tx.orderLine.create({
            data: {
              tenantId: scopedTenantId,
              orderId: order.id,
              productId: line.productId,
              sessionLineId: line.id,
              sku: line.sku,
              productName: line.productName,
              unitOfMeasure: line.unitOfMeasure,
              quantity: line.quantity,
              sourceType: line.sourceType,
              sourceId: line.sourceId,
              evidenceBundleId: line.evidenceBundleId,
              visionEventId: line.visionEventId,
              // Legacy opaque refs stay external on order lines too.
              externalVisionEventRef: line.externalVisionEventRef,
              externalEvidenceBundleRef: line.externalEvidenceBundleRef,
              vlmReviewId: line.vlmReviewId,
              evidenceScore: line.evidenceScore,
              evidenceQuality: line.evidenceQuality,
              reasonCodes: line.reasonCodes,
              createdById: input.createdById,
            },
          });
        }

        const after = await tx.checkoutSession.update({
          where: { id: session.id },
          data: { status: CheckoutSessionStatus.COMPLETED, endedAt: now },
        });

        const fullOrder = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: COMPLETION_ORDER_INCLUDE,
        });
        await this.auditLog.record(
          builders.sessionCompleted(session, after),
          tx,
        );
        await this.auditLog.record(builders.orderCreated(fullOrder), tx);
        return { order: fullOrder, replayed: false };
      })
      .catch((error: unknown) => {
        if (error instanceof CompletionStockRejected) {
          return { stockFailure: error.failure, sku: error.sku };
        }
        throw error;
      });
  }

  /**
   * Resolves caller-supplied evidence lineage references against the SAME
   * tenant inside the mutation transaction. The line/session evidence chain
   * (evidenceBundleId → EvidenceBundle, visionEventId → VisionEvent) is
   * canonical — checkout completion copies it onto order lines — so a
   * nonexistent or cross-tenant id is a controlled rejection, never
   * persisted lineage.
   *
   * A referenced event must also actually BELONG here: an event bound to a
   * different checkout session must not be stamped onto this one's lineage
   * (targetSessionId is undefined for session creation, where any existing
   * binding means the event belongs to another session). When BOTH an event
   * and a bundle are supplied, the bundle must be exactly the event's own —
   * including the case where the event carries none — so no cross-bundle
   * lineage can be asserted.
   *
   * vlmReviewId is deliberately NOT resolved here: per the API contract it
   * is an OPAQUE reference to a future VLM adapter's review — not a
   * VisionEventReview id — so no owned table can vouch for it yet. It stays
   * a screened, uninterpreted string until a VLM review registry exists.
   *
   * usage 'line' (add/update line) additionally rejects basket-affecting
   * events as NEW line lineage in EVERY status: POST /vision-events/:id/
   * review is the ONLY path that may apply such an event to a basket.
   * PENDING_REVIEW rejects because the interaction would be counted twice
   * (once by the manual line, once again on approval); decided events
   * reject because their one-shot review already recorded exactly what
   * they did (or, for REJECT, that they did nothing) — citing them on
   * another manual mutation would re-apply or contradict that record. The
   * single exception is keptVisionEventId: the event a PATCHED line
   * already carries (typically the review-created line itself) stays
   * citable so the line remains manually correctable without forging any
   * new lineage. usage 'session' (session creation) may still claim a
   * pending event as session lineage — that is the bind-then-review flow,
   * where the basket effect is applied exactly once, by the review, and
   * no line is created here.
   */
  private async validateEvidenceRefs(
    tx: Prisma.TransactionClient,
    tenantId: string,
    refs: EvidenceRefs,
    target: {
      sessionId?: string;
      unitId: string;
      locationId: string;
    },
    usage: 'session' | 'line',
    keptVisionEventId?: string,
  ): Promise<EvidenceRefRejection | null> {
    if (refs.evidenceBundleId !== undefined) {
      const bundle = await tx.evidenceBundle.findFirst({
        where: { id: refs.evidenceBundleId, tenantId },
        select: { id: true },
      });
      if (!bundle) {
        return 'evidence-bundle-not-found';
      }
    }
    if (refs.visionEventId !== undefined) {
      const event = await tx.visionEvent.findFirst({
        where: { id: refs.visionEventId, tenantId },
        select: {
          id: true,
          sessionId: true,
          evidenceBundleId: true,
          unitId: true,
          locationId: true,
          status: true,
          type: true,
        },
      });
      if (!event) {
        return 'vision-event-not-found';
      }
      // The event must have happened at the session's own unit AND store —
      // an approval applied later mutates THIS session's basket, so lineage
      // from another unit (or a relocated unit's other store) is never
      // claimable, same rule as ingest-time session binding.
      if (event.unitId !== target.unitId) {
        return 'vision-event-unit-mismatch';
      }
      if (event.locationId !== target.locationId) {
        return 'vision-event-location-mismatch';
      }
      // An unbound event is legitimate lineage (it gets CLAIMED for the
      // target session below); a bound event only for its own session.
      if (event.sessionId && event.sessionId !== target.sessionId) {
        return 'vision-event-session-mismatch';
      }
      // Basket-affecting events reach the basket ONLY through the review
      // endpoint. As line lineage: pending rejects (a manual line now AND
      // an approval later would double-count the product); decided rejects
      // unless it is the reference the patched line ALREADY carries (a
      // decided event's one-shot review recorded its exact effect — citing
      // it on another line would re-apply an APPROVED pickup or contradict
      // a REJECTED one).
      if (
        usage === 'line' &&
        BASKET_AFFECTING_EVENT_TYPES.includes(event.type)
      ) {
        if (event.status === VisionEventStatus.PENDING_REVIEW) {
          return 'vision-event-pending-review';
        }
        if (refs.visionEventId !== keptVisionEventId) {
          return 'vision-event-already-applied';
        }
      }
      // Claiming an unbound event is a BINDING — the same terminal-state
      // rule as POST /vision-events/:id/session applies: a decided event
      // never binds anywhere new. An event already bound to this session
      // stays citable whatever its decision (it may have produced this
      // very line).
      if (
        !event.sessionId &&
        event.status !== VisionEventStatus.PENDING_REVIEW
      ) {
        return 'vision-event-decided';
      }
      // Strict pair check: an event that never carried the asserted bundle
      // (different bundle OR no bundle at all) rejects.
      if (
        refs.evidenceBundleId !== undefined &&
        event.evidenceBundleId !== refs.evidenceBundleId
      ) {
        return 'evidence-bundle-event-mismatch';
      }
    }
    return null;
  }

  /**
   * Atomically CLAIMS an unbound event for the target session, so a later
   * (or concurrent) POST /vision-events/:id/session can never rebind an
   * event some session/line already cites as lineage. The compare-and-set
   * (WHERE sessionId IS NULL) races safely against bindSession, which uses
   * the same conditional write; on a lost race the event is re-read and
   * accepted only if it now belongs to this very session. The claim is a
   * state change on the event and is audited via the caller's builder.
   */
  private async claimVisionEvent(
    tx: Prisma.TransactionClient,
    tenantId: string,
    eventId: string,
    sessionId: string,
    buildClaimAudit?: (eventId: string, sessionId: string) => AuditEntry,
  ): Promise<EvidenceRefRejection | null> {
    const claimed = await tx.visionEvent.updateMany({
      // Only an UNBOUND, still-PENDING event is claimable — a decided event
      // never binds anywhere new (same terminal rule as bindSession), and
      // the sessionId CAS keeps concurrent binds/claims from stomping each
      // other.
      where: {
        id: eventId,
        tenantId,
        sessionId: null,
        status: VisionEventStatus.PENDING_REVIEW,
      },
      data: { sessionId },
    });
    if (claimed.count === 0) {
      const current = await tx.visionEvent.findFirst({
        where: { id: eventId, tenantId },
        select: { sessionId: true, status: true },
      });
      if (current && current.sessionId === sessionId) {
        // Already bound to this very session — nothing to claim.
        return null;
      }
      if (
        current &&
        current.sessionId === null &&
        current.status !== VisionEventStatus.PENDING_REVIEW
      ) {
        return 'vision-event-decided';
      }
      return 'vision-event-session-mismatch';
    }
    if (buildClaimAudit) {
      await this.auditLog.record(buildClaimAudit(eventId, sessionId), tx);
    }
    return null;
  }

  /**
   * All session mutations take this lock first, so status transitions, line
   * mutations, and (duplicate) completions serialize instead of deciding on
   * a stale status read. Held until the surrounding transaction ends.
   */
  private async lockSession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sessionId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${checkoutSessionAdvisoryLockKey(
      tenantId,
      sessionId,
    )}))::text`;
  }
}
