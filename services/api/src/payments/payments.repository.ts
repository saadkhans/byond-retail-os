import { Injectable } from '@nestjs/common';
import {
  Order,
  OrderPaymentStatus,
  OrderStatus,
  PaymentAuthorization,
  PaymentAuthorizationStatus,
  PaymentCapture,
  PaymentCaptureStatus,
  PaymentIntent,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ReconciliationStatus,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import {
  orderPaymentAdvisoryLockKey,
  paymentIntentAdvisoryLockKey,
} from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import {
  AUTHORIZABLE_STATUSES,
  CAPTURABLE_STATUSES,
  isTerminalPaymentStatus,
} from './payment-state-machine';

/** Read shape for intent list responses (light — no child collections). */
export const INTENT_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
    },
  },
  session: { select: { id: true, status: true } },
} satisfies Prisma.PaymentIntentInclude;

/** Read shape for intent detail: every child record in deterministic order. */
export const INTENT_DETAIL_INCLUDE = {
  ...INTENT_INCLUDE,
  authorizations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  captures: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  events: { orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] },
  reconciliationRecords: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.PaymentIntentInclude;

export type PaymentIntentWithRefs = Prisma.PaymentIntentGetPayload<{
  include: typeof INTENT_INCLUDE;
}>;

export type PaymentIntentDetail = Prisma.PaymentIntentGetPayload<{
  include: typeof INTENT_DETAIL_INCLUDE;
}>;

export type CaptureWithIntent = Prisma.PaymentCaptureGetPayload<{
  include: { intent: { select: { id: true; status: true; orderId: true } } };
}>;

export const CAPTURE_INCLUDE = {
  intent: { select: { id: true, status: true, orderId: true } },
} satisfies Prisma.PaymentCaptureInclude;

/** Instrument metadata + provider references carried by intent creation. */
export interface IntentReferenceInput {
  provider?: PaymentProvider;
  providerRef?: string;
  providerCustomerRef?: string;
  instrumentBrand?: string;
  instrumentLast4?: string;
  instrumentExpiryMonth?: number;
  instrumentExpiryYear?: number;
  instrumentWallet?: string;
  description?: string;
}

export type CreateIntentInput = IntentReferenceInput & {
  orderId?: string;
  checkoutSessionId?: string;
  amountMinor: number;
  currencyCode: string;
  idempotencyKey?: string;
  createdById?: string;
};

export type CreateIntentRejection =
  | 'order-not-found'
  | 'session-not-found'
  | 'order-session-mismatch';

export type TransitionRejection =
  | 'terminal-blocked'
  | 'invalid-state'
  | 'idempotency-key-conflict'
  // The linked order is CANCELLED — a cancelled order must never be
  // authorized/paid without a returns/refunds flow.
  | 'order-cancelled'
  // The linked order is already PAID (by this or another intent) — capturing
  // again would double-capture the same order.
  | 'order-already-paid'
  // A session-linked intent was captured before its order exists yet. We
  // reject rather than silently leave the (future) order UNPAID forever.
  | 'order-not-ready';

/**
 * Thrown INSIDE the capture transaction when the linked-order projection loses
 * a concurrency race (a competing capture already paid the order, or it was
 * cancelled after we resolved it). Throwing rolls the whole capture back — no
 * duplicate PaymentCapture/reconciliation row survives — and is mapped to a
 * controlled 409 at the transaction boundary.
 */
class CaptureOrderConflict extends Error {
  constructor() {
    super('capture-order-conflict');
    this.name = 'CaptureOrderConflict';
  }
}

export interface IntentResult {
  intent: PaymentIntentDetail;
  replayed: boolean;
}

export interface AuthorizeAuditBuilders {
  intentAuthorized: (before: PaymentIntent, after: PaymentIntent) => AuditEntry;
  authorizationCreated: (auth: PaymentAuthorization) => AuditEntry;
  orderUpdated?: (before: Order, after: Order) => AuditEntry;
}

export interface CaptureAuditBuilders {
  intentCaptured: (before: PaymentIntent, after: PaymentIntent) => AuditEntry;
  captureCreated: (capture: PaymentCapture) => AuditEntry;
  reconciliationCreated: (record: { id: string }) => AuditEntry;
  orderPaid?: (before: Order, after: Order) => AuditEntry;
}

export interface CancelAuditBuilders {
  intentCancelled: (before: PaymentIntent, after: PaymentIntent) => AuditEntry;
  orderUpdated?: (before: Order, after: Order) => AuditEntry;
}

export interface FailAuditBuilders {
  intentFailed: (before: PaymentIntent, after: PaymentIntent) => AuditEntry;
  orderUpdated?: (before: Order, after: Order) => AuditEntry;
}

export interface BindAuditBuilders {
  intentBound: (before: PaymentIntent, after: PaymentIntent) => AuditEntry;
  orderUpdated?: (before: Order, after: Order) => AuditEntry;
}

export type BindRejection =
  | 'bind-requires-target'
  | 'order-not-found'
  | 'session-not-found'
  | 'order-session-mismatch'
  | 'already-bound'
  | 'order-cancelled'
  | 'order-already-paid';

@Injectable()
export class PaymentsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  // ------------------------------------------------------------------ create

  /**
   * Creates a payment intent after tenant-scoped reference checks. An intent
   * may be created with no order/session (walk-out: association happens
   * before/during checkout), or bound to an order and/or session of the SAME
   * tenant. Reference checks run inside the insert transaction, with the
   * composite same-tenant FKs in migration SQL as the backstop.
   */
  createIntent(
    tenantId: string,
    data: CreateIntentInput,
    buildAuditEntry: (intent: PaymentIntentDetail) => AuditEntry,
  ): Promise<IntentResult | CreateIntentRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      if (data.idempotencyKey) {
        const existing = await tx.paymentIntent.findFirst({
          where: {
            tenantId: scopedTenantId,
            idempotencyKey: data.idempotencyKey,
          },
          include: INTENT_DETAIL_INCLUDE,
        });
        if (existing) {
          return { intent: existing, replayed: true };
        }
      }
      let order: { id: string; checkoutSessionId: string } | null = null;
      if (data.orderId) {
        order = await tx.order.findFirst({
          where: { id: data.orderId, tenantId: scopedTenantId },
          select: { id: true, checkoutSessionId: true },
        });
        if (!order) {
          return 'order-not-found' as const;
        }
      }
      if (data.checkoutSessionId) {
        const session = await tx.checkoutSession.findFirst({
          where: { id: data.checkoutSessionId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!session) {
          return 'session-not-found' as const;
        }
        // If BOTH an order and a session are given, they must describe the
        // same checkout: an order bound to session X must not have its payment
        // linked to unrelated session Y.
        if (order && order.checkoutSessionId !== data.checkoutSessionId) {
          return 'order-session-mismatch' as const;
        }
      }
      const intent = await tx.paymentIntent.create({
        data: {
          tenantId: scopedTenantId,
          orderId: data.orderId,
          checkoutSessionId: data.checkoutSessionId,
          provider: data.provider,
          amountMinor: data.amountMinor,
          currencyCode: data.currencyCode,
          providerRef: data.providerRef,
          providerCustomerRef: data.providerCustomerRef,
          instrumentBrand: data.instrumentBrand,
          instrumentLast4: data.instrumentLast4,
          instrumentExpiryMonth: data.instrumentExpiryMonth,
          instrumentExpiryYear: data.instrumentExpiryYear,
          instrumentWallet: data.instrumentWallet,
          description: data.description,
          idempotencyKey: data.idempotencyKey,
          createdById: data.createdById,
        },
        include: INTENT_DETAIL_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(intent), tx);
      return { intent, replayed: false };
    });
  }

  // ------------------------------------------------------------------- reads

  findIntentById(
    tenantId: string,
    id: string,
  ): Promise<PaymentIntentDetail | null> {
    return this.prisma.paymentIntent.findFirst({
      where: this.scope(tenantId, { id }),
      include: INTENT_DETAIL_INCLUDE,
    });
  }

  findIntentByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentDetail | null> {
    return this.prisma.paymentIntent.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
      include: INTENT_DETAIL_INCLUDE,
    });
  }

  async searchIntents(
    tenantId: string,
    filters: {
      status?: PaymentStatus;
      provider?: PaymentProvider;
      orderId?: string;
      checkoutSessionId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: PaymentIntentWithRefs[]; total: number }> {
    const where: Prisma.PaymentIntentWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.provider) {
      where.provider = filters.provider;
    }
    if (filters.orderId) {
      where.orderId = filters.orderId;
    }
    if (filters.checkoutSessionId) {
      where.checkoutSessionId = filters.checkoutSessionId;
    }
    const [items, total] = await Promise.all([
      this.prisma.paymentIntent.findMany({
        where,
        include: INTENT_INCLUDE,
        // id is the deterministic tie-breaker: createdAt is millisecond
        // precision, so concurrent intents could otherwise reorder across
        // skip/take pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.paymentIntent.count({ where }),
    ]);
    return { items, total };
  }

  async searchCaptures(
    tenantId: string,
    filters: {
      status?: PaymentCaptureStatus;
      intentId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: CaptureWithIntent[]; total: number }> {
    const where: Prisma.PaymentCaptureWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.intentId) {
      where.intentId = filters.intentId;
    }
    const [items, total] = await Promise.all([
      this.prisma.paymentCapture.findMany({
        where,
        include: CAPTURE_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.paymentCapture.count({ where }),
    ]);
    return { items, total };
  }

  /** Replay lookup for the capture idempotency-key P2002 race. */
  findCaptureByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PaymentCapture | null> {
    return this.prisma.paymentCapture.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
    });
  }

  /** Replay lookup for the authorization idempotency-key P2002 race. */
  findAuthorizationByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PaymentAuthorization | null> {
    return this.prisma.paymentAuthorization.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
    });
  }

  // --------------------------------------------------------------- authorize

  /**
   * Simulates an authorization hold. Legal only from CREATED /
   * REQUIRES_AUTHORIZATION. Idempotent: the same key replays the existing
   * AUTHORIZED intent; the same key on a different intent is a controlled
   * conflict. Runs under the intent advisory lock so concurrent transitions
   * serialize instead of racing on a stale status.
   */
  authorize(
    tenantId: string,
    id: string,
    input: {
      amountMinor?: number;
      providerRef?: string;
      expiresAt?: Date;
      idempotencyKey?: string;
      actorId?: string;
    },
    builders: AuthorizeAuditBuilders,
  ): Promise<IntentResult | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockIntent(tx, scopedTenantId, id);
      const intent = await tx.paymentIntent.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!intent) {
        return null;
      }
      if (input.idempotencyKey) {
        const existing = await tx.paymentAuthorization.findFirst({
          where: {
            tenantId: scopedTenantId,
            idempotencyKey: input.idempotencyKey,
          },
        });
        if (existing) {
          if (
            existing.intentId === id &&
            intent.status === PaymentStatus.AUTHORIZED
          ) {
            return this.replay(tx, scopedTenantId, id);
          }
          return 'idempotency-key-conflict' as const;
        }
      }
      if (intent.status === PaymentStatus.AUTHORIZED) {
        // Already authorized with no matching key: not a legal re-authorize.
        return 'invalid-state' as const;
      }
      if (isTerminalPaymentStatus(intent.status)) {
        return 'terminal-blocked' as const;
      }
      if (!AUTHORIZABLE_STATUSES.includes(intent.status)) {
        return 'invalid-state' as const;
      }
      // Resolve and LOCK the linked order (by orderId, else by the checkout
      // session the intent belongs to), then re-read it under the lock so the
      // CANCELLED/PAID checks see the latest committed state. A CANCELLED order
      // must never be authorized, and an already-PAID order must not accumulate
      // further simulated holds.
      const order = await this.lockAndReloadLinkedOrder(tx, scopedTenantId, intent);
      // A session-linked intent whose order has not been generated yet: reject,
      // matching capture. A pre-order authorization would otherwise be lost
      // when the order is later created UNPAID (walk-out pre-auth uses a
      // STANDALONE intent + the bind operation instead — see bind()).
      if (!order && intent.checkoutSessionId) {
        return 'order-not-ready' as const;
      }
      if (order && order.status === OrderStatus.CANCELLED) {
        return 'order-cancelled' as const;
      }
      if (order && order.paymentStatus === OrderPaymentStatus.PAID) {
        return 'order-already-paid' as const;
      }
      const now = new Date();
      const authorization = await tx.paymentAuthorization.create({
        data: {
          tenantId: scopedTenantId,
          intentId: id,
          status: PaymentAuthorizationStatus.AUTHORIZED,
          amountMinor: input.amountMinor ?? intent.amountMinor,
          providerRef: input.providerRef,
          authorizedAt: now,
          expiresAt: input.expiresAt,
          idempotencyKey: input.idempotencyKey,
          createdById: input.actorId,
        },
      });
      const after = await tx.paymentIntent.update({
        where: { id_tenantId: { id: intent.id, tenantId: scopedTenantId } },
        data: { status: PaymentStatus.AUTHORIZED, authorizedAt: now },
      });
      await this.auditLog.record(builders.intentAuthorized(intent, after), tx);
      await this.auditLog.record(
        builders.authorizationCreated(authorization),
        tx,
      );
      // Project onto the linked order (never downgrades a PAID or touches a
      // CANCELLED order).
      await this.projectOrderPaymentStatus(
        tx,
        order,
        OrderPaymentStatus.AUTHORIZED,
        null,
        builders.orderUpdated,
      );
      return this.replay(tx, scopedTenantId, id);
    });
  }

  // ----------------------------------------------------------------- capture

  /**
   * Simulates a full capture. Legal only from AUTHORIZED / CAPTURE_PENDING.
   * The (tenantId, idempotencyKey) unique on PaymentCapture is the last-line
   * backstop against a DOUBLE CAPTURE — the same key replays the original
   * capture instead of moving money twice; a different key on an
   * already-CAPTURED intent is rejected. On success the intent goes CAPTURED,
   * a PENDING reconciliation record is seeded, and a linked order flips to
   * PAID — the ONLY path that marks an order paid.
   */
  capture(
    tenantId: string,
    id: string,
    input: {
      providerRef?: string;
      idempotencyKey?: string;
      actorId?: string;
    },
    builders: CaptureAuditBuilders,
  ): Promise<IntentResult | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma
      .$transaction(async (tx) => {
        await this.lockIntent(tx, scopedTenantId, id);
        const intent = await tx.paymentIntent.findFirst({
          where: { id, tenantId: scopedTenantId },
        });
        if (!intent) {
          return null;
        }
        if (input.idempotencyKey) {
          const existing = await tx.paymentCapture.findFirst({
            where: {
              tenantId: scopedTenantId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          if (existing) {
            if (
              existing.intentId === id &&
              intent.status === PaymentStatus.CAPTURED
            ) {
              return this.replay(tx, scopedTenantId, id);
            }
            return 'idempotency-key-conflict' as const;
          }
        }
        if (intent.status === PaymentStatus.CAPTURED) {
          // Already captured with no matching key: never a legal recapture.
          return 'invalid-state' as const;
        }
        if (isTerminalPaymentStatus(intent.status)) {
          return 'terminal-blocked' as const;
        }
        if (!CAPTURABLE_STATUSES.includes(intent.status)) {
          return 'invalid-state' as const;
        }
        // Resolve and LOCK the linked order — by orderId, else by the checkout
        // session this intent was created for. The order lock serializes
        // captures across DIFFERENT intents for the SAME order, so only one can
        // pay it. Re-read under the lock so the CANCELLED/PAID checks and the
        // projection all see the latest committed state.
        const order = await this.lockAndReloadLinkedOrder(tx, scopedTenantId, intent);
        // A session-linked intent whose order has not been generated yet: we
        // reject rather than record a capture the (future) order can never
        // learn about (which would leave it UNPAID forever).
        if (!order && intent.checkoutSessionId) {
          return 'order-not-ready' as const;
        }
        if (order && order.status === OrderStatus.CANCELLED) {
          return 'order-cancelled' as const;
        }
        if (order && order.paymentStatus === OrderPaymentStatus.PAID) {
          return 'order-already-paid' as const;
        }
        const now = new Date();
        const capture = await tx.paymentCapture.create({
          data: {
            tenantId: scopedTenantId,
            intentId: id,
            status: PaymentCaptureStatus.SUCCEEDED,
            amountMinor: intent.amountMinor,
            providerRef: input.providerRef,
            capturedAt: now,
            idempotencyKey: input.idempotencyKey,
            createdById: input.actorId,
          },
        });
        const after = await tx.paymentIntent.update({
          where: { id_tenantId: { id: intent.id, tenantId: scopedTenantId } },
          data: {
            status: PaymentStatus.CAPTURED,
            capturedAmountMinor: intent.amountMinor,
            capturedAt: now,
          },
        });
        // Reconciliation foundation: a PENDING record links the captured
        // payment to future provider settlement (no accounting in Phase 6).
        const reconciliation = await tx.paymentReconciliationRecord.create({
          data: {
            tenantId: scopedTenantId,
            intentId: id,
            captureId: capture.id,
            provider: intent.provider,
            status: ReconciliationStatus.PENDING,
            providerRef: capture.providerRef,
            expectedAmountMinor: capture.amountMinor,
            currencyCode: intent.currencyCode,
          },
        });
        await this.auditLog.record(builders.intentCaptured(intent, after), tx);
        await this.auditLog.record(builders.captureCreated(capture), tx);
        await this.auditLog.record(
          builders.reconciliationCreated(reconciliation),
          tx,
        );
        // CAPTURED is the ONLY state that marks an order PAID. The projection
        // is a CONDITIONAL, tenant-scoped update (status != CANCELLED,
        // paymentStatus != PAID). If it matches zero rows, a concurrent
        // capture/cancel won the order after our checks — throw to ROLL BACK
        // this whole capture so no duplicate capture/reconciliation row
        // survives, and the loser gets a controlled 409.
        if (order) {
          const projected = await this.projectOrderPaymentStatus(
            tx,
            order,
            OrderPaymentStatus.PAID,
            now,
            builders.orderPaid,
          );
          if (!projected) {
            throw new CaptureOrderConflict();
          }
          // The order is now PAID, so any SIBLING intent's simulated hold on
          // this order is stale (its later capture is already blocked by the
          // paid-order guard). Void those active holds in the SAME transaction
          // so no hold outlives the paid order — including intents linked only
          // via the checkout session. The capturing intent's own authorization
          // is left as-is (its hold was consumed by the capture).
          await this.voidSiblingHolds(tx, scopedTenantId, order, id);
        }
        return this.replay(tx, scopedTenantId, id);
      })
      .catch((error: unknown) => {
        if (error instanceof CaptureOrderConflict) {
          return 'order-already-paid' as const;
        }
        throw error;
      });
  }

  // ------------------------------------------------------------ cancel/void

  /**
   * Cancels a pre-auth intent (→ CANCELLED) or voids an authorized one
   * (→ VOIDED, voiding its authorization holds). CAPTURE_PENDING and terminal
   * intents are rejected. A voided intent projects VOIDED onto a linked order
   * (never onto a PAID one).
   */
  cancel(
    tenantId: string,
    id: string,
    input: { reason?: string; actorId?: string },
    builders: CancelAuditBuilders,
  ): Promise<IntentResult | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockIntent(tx, scopedTenantId, id);
      const intent = await tx.paymentIntent.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!intent) {
        return null;
      }
      if (isTerminalPaymentStatus(intent.status)) {
        return 'terminal-blocked' as const;
      }
      let target: PaymentStatus;
      if (
        intent.status === PaymentStatus.CREATED ||
        intent.status === PaymentStatus.REQUIRES_AUTHORIZATION
      ) {
        target = PaymentStatus.CANCELLED;
      } else if (intent.status === PaymentStatus.AUTHORIZED) {
        target = PaymentStatus.VOIDED;
      } else {
        // CAPTURE_PENDING: money is in flight — must be captured or failed.
        return 'invalid-state' as const;
      }
      const now = new Date();
      const after = await tx.paymentIntent.update({
        where: { id_tenantId: { id: intent.id, tenantId: scopedTenantId } },
        data: {
          status: target,
          cancelledAt: now,
          failureReason: input.reason,
        },
      });
      if (target === PaymentStatus.VOIDED) {
        await tx.paymentAuthorization.updateMany({
          where: {
            tenantId: scopedTenantId,
            intentId: id,
            status: PaymentAuthorizationStatus.AUTHORIZED,
          },
          data: {
            status: PaymentAuthorizationStatus.VOIDED,
            voidedAt: now,
          },
        });
      }
      await this.auditLog.record(builders.intentCancelled(intent, after), tx);
      if (target === PaymentStatus.VOIDED) {
        // Lock + re-read the order, then recompute from ALL linked intents: a
        // sibling with an active hold keeps the order AUTHORIZED; VOIDED is only
        // projected once no active hold and no captured intent remains.
        const order = await this.lockAndReloadLinkedOrder(
          tx,
          scopedTenantId,
          intent,
        );
        if (order) {
          await this.recomputeOrderPaymentStatus(
            tx,
            scopedTenantId,
            order,
            now,
            builders.orderUpdated,
          );
        }
      }
      return this.replay(tx, scopedTenantId, id);
    });
  }

  // -------------------------------------------------------------------- fail

  /**
   * Marks a non-terminal intent FAILED (simulated decline). A linked order
   * projects PAYMENT_FAILED — never PAID: a payment failure can never mark an
   * order paid (AGENTS.md core invariant).
   */
  fail(
    tenantId: string,
    id: string,
    input: { reason?: string; actorId?: string },
    builders: FailAuditBuilders,
  ): Promise<IntentResult | TransitionRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockIntent(tx, scopedTenantId, id);
      const intent = await tx.paymentIntent.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!intent) {
        return null;
      }
      if (isTerminalPaymentStatus(intent.status)) {
        return 'terminal-blocked' as const;
      }
      // Take the order lock and re-read under it (finding: serialize non-capture
      // projections) so a concurrent fail/void can't audit a stale order.
      const order = await this.lockAndReloadLinkedOrder(tx, scopedTenantId, intent);
      // A session-linked intent whose order does not exist yet: reject, matching
      // authorize/capture — a pre-order FAILED state would otherwise be lost
      // when the order is later created UNPAID.
      if (!order && intent.checkoutSessionId) {
        return 'order-not-ready' as const;
      }
      const now = new Date();
      const after = await tx.paymentIntent.update({
        where: { id_tenantId: { id: intent.id, tenantId: scopedTenantId } },
        data: {
          status: PaymentStatus.FAILED,
          failedAt: now,
          failureReason: input.reason,
        },
      });
      // FAILED is terminal — an authorized intent can no longer be voided, so
      // void its active authorization holds HERE in the same transaction. A
      // simulated hold must never outlive its (now FAILED) intent.
      await tx.paymentAuthorization.updateMany({
        where: {
          tenantId: scopedTenantId,
          intentId: id,
          status: PaymentAuthorizationStatus.AUTHORIZED,
        },
        data: {
          status: PaymentAuthorizationStatus.VOIDED,
          voidedAt: now,
        },
      });
      await this.auditLog.record(builders.intentFailed(intent, after), tx);
      // Recompute from ALL linked intents: if a SIBLING intent still holds an
      // active authorization, the order stays AUTHORIZED (this failure does not
      // downgrade it); PAYMENT_FAILED is only projected once no active hold and
      // no captured intent remains.
      if (order) {
        await this.recomputeOrderPaymentStatus(
          tx,
          scopedTenantId,
          order,
          now,
          builders.orderUpdated,
        );
      }
      return this.replay(tx, scopedTenantId, id);
    });
  }

  // -------------------------------------------------------------------- bind

  /**
   * Binds a previously-unlinked (or session-only) intent to an order and/or
   * checkout session, then projects the intent's CURRENT state onto the bound
   * order — this is how a standalone walk-out intent, once authorized/captured,
   * finally marks its order PAID. Tenant-safe: order/session are resolved
   * within the caller's tenant. Re-binding to the SAME target replays; a
   * DIFFERENT order/session is a controlled conflict (no silent rebinding). The
   * order lock + conditional projection make a CAPTURED bind race-safe against
   * a concurrent capture/cancel on the same order.
   */
  bind(
    tenantId: string,
    id: string,
    input: {
      orderId?: string;
      checkoutSessionId?: string;
      actorId?: string;
    },
    builders: BindAuditBuilders,
  ): Promise<IntentResult | BindRejection | null> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma
      .$transaction(async (tx) => {
        await this.lockIntent(tx, scopedTenantId, id);
        const intent = await tx.paymentIntent.findFirst({
          where: { id, tenantId: scopedTenantId },
        });
        if (!intent) {
          return null;
        }
        if (!input.orderId && !input.checkoutSessionId) {
          return 'bind-requires-target' as const;
        }
        // Rebinding to a DIFFERENT already-bound target is a conflict; the same
        // target replays. A null current binding may be set for the first time.
        if (
          input.orderId &&
          intent.orderId &&
          intent.orderId !== input.orderId
        ) {
          return 'already-bound' as const;
        }
        if (
          input.checkoutSessionId &&
          intent.checkoutSessionId &&
          intent.checkoutSessionId !== input.checkoutSessionId
        ) {
          return 'already-bound' as const;
        }
        // Validate the checkout-session target (if supplied).
        if (input.checkoutSessionId) {
          const session = await tx.checkoutSession.findFirst({
            where: { id: input.checkoutSessionId, tenantId: scopedTenantId },
            select: { id: true },
          });
          if (!session) {
            return 'session-not-found' as const;
          }
        }
        // Resolve and LOCK the target order (a freshly-supplied orderId, else
        // the intent's existing one) BEFORE any write, so every check below —
        // and the rejection paths — happen on committed state with no mutation.
        const targetOrderId = input.orderId ?? intent.orderId;
        let order: Order | null = null;
        if (input.orderId) {
          const exists = await tx.order.findFirst({
            where: { id: input.orderId, tenantId: scopedTenantId },
            select: { id: true },
          });
          if (!exists) {
            return 'order-not-found' as const;
          }
        }
        if (targetOrderId) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderPaymentAdvisoryLockKey(
            scopedTenantId,
            targetOrderId,
          )}))`;
          order = await tx.order.findFirst({
            where: { id: targetOrderId, tenantId: scopedTenantId },
          });
        }
        // Session consistency: the bound order must belong to the intent's
        // EFFECTIVE checkout session — the one supplied now OR the one the
        // intent is already linked to. Prevents session-A + order-from-session-B.
        const effectiveSession =
          input.checkoutSessionId ?? intent.checkoutSessionId;
        if (
          order &&
          effectiveSession &&
          order.checkoutSessionId !== effectiveSession
        ) {
          return 'order-session-mismatch' as const;
        }
        // Whether this call NEWLY establishes the order link (vs an idempotent
        // re-bind to the same order, which must not re-project).
        const orderNewlyBound = Boolean(input.orderId) && !intent.orderId;
        const target = orderNewlyBound
          ? this.orderPaymentStatusForIntent(intent.status)
          : null;
        // Pre-write guards (roll back = never write): a newly-bound order must
        // not be CANCELLED, and an AUTHORIZED/CAPTURE_PENDING/CAPTURED intent
        // must not bind to an already-PAID order (would strand a live hold or
        // double-pay). Rejecting here — before the update/audit — leaves the
        // intent untouched.
        if (order && orderNewlyBound) {
          if (order.status === OrderStatus.CANCELLED) {
            return 'order-cancelled' as const;
          }
          if (
            order.paymentStatus === OrderPaymentStatus.PAID &&
            (intent.status === PaymentStatus.AUTHORIZED ||
              intent.status === PaymentStatus.CAPTURE_PENDING ||
              intent.status === PaymentStatus.CAPTURED)
          ) {
            return 'order-already-paid' as const;
          }
        }
        const now = new Date();
        const before = intent;
        const after = await tx.paymentIntent.update({
          where: { id_tenantId: { id: intent.id, tenantId: scopedTenantId } },
          data: {
            orderId: input.orderId ?? undefined,
            checkoutSessionId: input.checkoutSessionId ?? undefined,
          },
        });
        await this.auditLog.record(builders.intentBound(before, after), tx);

        // Project the intent's current state onto the FRESHLY-bound order.
        if (target && order) {
          if (target === OrderPaymentStatus.PAID) {
            const projected = await this.projectOrderPaymentStatus(
              tx,
              order,
              OrderPaymentStatus.PAID,
              intent.capturedAt ?? now,
              builders.orderUpdated,
            );
            if (!projected) {
              throw new CaptureOrderConflict();
            }
            // Binding a CAPTURED intent paid the order — release sibling holds
            // (including session-linked intents), exactly like a direct capture.
            await this.voidSiblingHolds(tx, scopedTenantId, order, id);
          } else {
            await this.projectOrderPaymentStatus(
              tx,
              order,
              target,
              null,
              builders.orderUpdated,
            );
          }
        }
        return this.replay(tx, scopedTenantId, id);
      })
      .catch((error: unknown) => {
        if (error instanceof CaptureOrderConflict) {
          return 'order-already-paid' as const;
        }
        throw error;
      });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Maps a payment intent's state to the order paymentStatus it should project
   * on binding/creation. Non-financial states (CREATED/REQUIRES_AUTHORIZATION/
   * CANCELLED) return null — no projection.
   */
  private orderPaymentStatusForIntent(
    status: PaymentStatus,
  ): OrderPaymentStatus | null {
    switch (status) {
      case PaymentStatus.CAPTURED:
        return OrderPaymentStatus.PAID;
      case PaymentStatus.AUTHORIZED:
      case PaymentStatus.CAPTURE_PENDING:
        return OrderPaymentStatus.AUTHORIZED;
      case PaymentStatus.FAILED:
        return OrderPaymentStatus.PAYMENT_FAILED;
      case PaymentStatus.VOIDED:
        return OrderPaymentStatus.VOIDED;
      default:
        return null;
    }
  }

  private async replay(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<IntentResult> {
    const intent = await tx.paymentIntent.findFirstOrThrow({
      where: { id, tenantId },
      include: INTENT_DETAIL_INCLUDE,
    });
    return { intent, replayed: false };
  }

  /**
   * Resolves the order a payment intent projects onto. Binds by explicit
   * orderId first; otherwise, for a session-linked pre-order payment, by the
   * order generated from the SAME checkout session (so capturing a
   * session-only intent still marks that order PAID). Tenant-safe: both lookups
   * are scoped to the caller's tenant, so a cross-tenant session/order can
   * never be resolved. Returns null when nothing is linked yet (projection
   * safely no-ops — no error).
   */
  private resolveLinkedOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    intent: { orderId: string | null; checkoutSessionId: string | null },
  ): Promise<Order | null> {
    if (intent.orderId) {
      return tx.order.findFirst({
        where: { id: intent.orderId, tenantId },
      });
    }
    if (intent.checkoutSessionId) {
      return tx.order.findFirst({
        where: { checkoutSessionId: intent.checkoutSessionId, tenantId },
      });
    }
    return Promise.resolve(null);
  }

  /**
   * Resolves the linked order, then takes the per-order advisory lock and
   * re-reads it under that lock. The lock serializes payment mutations that
   * project onto the SAME order across DIFFERENT intents (the per-intent lock
   * cannot), and the re-read guarantees the CANCELLED/PAID checks and the
   * projection observe the latest committed order state. Returns null when no
   * order is linked yet (nothing to lock).
   */
  private async lockAndReloadLinkedOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    intent: { orderId: string | null; checkoutSessionId: string | null },
  ): Promise<Order | null> {
    const order = await this.resolveLinkedOrder(tx, tenantId, intent);
    if (!order) {
      return null;
    }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderPaymentAdvisoryLockKey(
      tenantId,
      order.id,
    )}))`;
    return tx.order.findFirst({ where: { id: order.id, tenantId } });
  }

  /**
   * All intents linked to an order — by explicit orderId OR by the order's
   * checkout session (a session-only intent binds to the order generated from
   * its session). Tenant-scoped. Used by sibling-hold release and by the
   * order-payment recompute so both consider the SAME intent set.
   */
  private loadLinkedIntents(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: { id: string; checkoutSessionId: string },
  ): Promise<{ id: string; status: PaymentStatus }[]> {
    return tx.paymentIntent.findMany({
      where: {
        tenantId,
        OR: [
          { orderId: order.id },
          { checkoutSessionId: order.checkoutSessionId },
        ],
      },
      select: { id: true, status: true },
    });
  }

  /**
   * Voids the active authorization holds of SIBLING intents on the same order
   * (every intent linked by orderId OR by the order's checkout session, except
   * the capturing one). Once the order is PAID, those holds are stale — the
   * siblings' captures are already blocked by the paid-order guard — so their
   * simulated holds are released here, in the same transaction. Tenant-scoped.
   */
  private async voidSiblingHolds(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: { id: string; checkoutSessionId: string },
    capturingIntentId: string,
  ): Promise<void> {
    const linked = await this.loadLinkedIntents(tx, tenantId, order);
    const siblingIds = linked
      .map((intent) => intent.id)
      .filter((intentId) => intentId !== capturingIntentId);
    if (siblingIds.length === 0) {
      return;
    }
    await tx.paymentAuthorization.updateMany({
      where: {
        tenantId,
        intentId: { in: siblingIds },
        status: PaymentAuthorizationStatus.AUTHORIZED,
      },
      data: {
        status: PaymentAuthorizationStatus.VOIDED,
        voidedAt: new Date(),
      },
    });
  }

  /**
   * Recomputes an order's paymentStatus from ALL linked intents and their
   * active authorization holds, then applies it via a conditional, tenant-safe
   * update. Priority: any CAPTURED intent → PAID; else any ACTIVE authorization
   * hold → AUTHORIZED (so failing/voiding ONE intent never downgrades an order
   * that a sibling still holds); else FAILED → PAYMENT_FAILED; else VOIDED →
   * VOIDED; else no change. NEVER touches a CANCELLED order and NEVER downgrades
   * a PAID one. Audits only on a real move. Used by fail()/cancel() so their
   * projection reflects the whole order, not just the acting intent.
   */
  private async recomputeOrderPaymentStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: Order,
    now: Date,
    buildAuditEntry?: (before: Order, after: Order) => AuditEntry,
  ): Promise<boolean> {
    if (
      order.status === OrderStatus.CANCELLED ||
      order.paymentStatus === OrderPaymentStatus.PAID
    ) {
      return false;
    }
    const linked = await this.loadLinkedIntents(tx, tenantId, order);
    const ids = linked.map((intent) => intent.id);
    const activeHolds =
      ids.length === 0
        ? 0
        : await tx.paymentAuthorization.count({
            where: {
              tenantId,
              intentId: { in: ids },
              status: PaymentAuthorizationStatus.AUTHORIZED,
            },
          });
    let target: OrderPaymentStatus | null = null;
    if (linked.some((intent) => intent.status === PaymentStatus.CAPTURED)) {
      target = OrderPaymentStatus.PAID;
    } else if (activeHolds > 0) {
      target = OrderPaymentStatus.AUTHORIZED;
    } else if (
      linked.some((intent) => intent.status === PaymentStatus.FAILED)
    ) {
      target = OrderPaymentStatus.PAYMENT_FAILED;
    } else if (
      linked.some((intent) => intent.status === PaymentStatus.VOIDED)
    ) {
      target = OrderPaymentStatus.VOIDED;
    }
    if (!target || order.paymentStatus === target) {
      return false;
    }
    return this.projectOrderPaymentStatus(
      tx,
      order,
      target,
      target === OrderPaymentStatus.PAID ? now : null,
      buildAuditEntry,
    );
  }

  /**
   * Projects a payment transition onto the ALREADY-RESOLVED linked order via a
   * CONDITIONAL, tenant-scoped update: it only fires when the order is NOT
   * CANCELLED and NOT already PAID. This is the race backstop — under
   * concurrency Postgres re-evaluates the WHERE after taking the row lock, so a
   * competing capture/cancel that commits first makes this update match zero
   * rows. Returns TRUE when the projection actually moved the order, FALSE when
   * it was skipped or lost the race (the capture path treats a lost race on a
   * linked order as a rollback-worthy conflict). Audits only on a real move.
   */
  private async projectOrderPaymentStatus(
    tx: Prisma.TransactionClient,
    order: Order | null,
    target: OrderPaymentStatus,
    paidAt: Date | null,
    buildAuditEntry?: (before: Order, after: Order) => AuditEntry,
  ): Promise<boolean> {
    if (!order || order.status === OrderStatus.CANCELLED) {
      return false;
    }
    if (order.paymentStatus === target) {
      return false;
    }
    const updated = await tx.order.updateMany({
      where: {
        id: order.id,
        tenantId: order.tenantId,
        // Never overwrite a cancelled or already-paid order (a PAID order stays
        // PAID; a failure/void never un-pays it).
        status: { not: OrderStatus.CANCELLED },
        paymentStatus: { not: OrderPaymentStatus.PAID },
      },
      data: {
        paymentStatus: target,
        paidAt: target === OrderPaymentStatus.PAID ? paidAt : order.paidAt,
      },
    });
    if (updated.count === 0) {
      return false;
    }
    if (buildAuditEntry) {
      const after = await tx.order.findFirstOrThrow({
        where: { id: order.id, tenantId: order.tenantId },
      });
      await this.auditLog.record(buildAuditEntry(order, after), tx);
    }
    return true;
  }

  private async lockIntent(
    tx: Prisma.TransactionClient,
    tenantId: string,
    intentId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentIntentAdvisoryLockKey(
      tenantId,
      intentId,
    )}))`;
  }
}
