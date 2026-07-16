import { Injectable } from '@nestjs/common';
import {
  Order,
  OrderPaymentStatus,
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
import { paymentIntentAdvisoryLockKey } from '../common/locks';
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
  | 'idempotency-key-conflict';

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
        where: { id: intent.id },
        data: { status: PaymentStatus.AUTHORIZED, authorizedAt: now },
      });
      await this.auditLog.record(builders.intentAuthorized(intent, after), tx);
      await this.auditLog.record(
        builders.authorizationCreated(authorization),
        tx,
      );
      // Project onto a linked order (never downgrades a PAID order).
      await this.projectOrderPaymentStatus(
        tx,
        scopedTenantId,
        intent.orderId,
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
    return this.prisma.$transaction(async (tx) => {
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
        where: { id: intent.id },
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
      // CAPTURED is the ONLY state that marks an order PAID.
      await this.projectOrderPaymentStatus(
        tx,
        scopedTenantId,
        intent.orderId,
        OrderPaymentStatus.PAID,
        now,
        builders.orderPaid,
      );
      return this.replay(tx, scopedTenantId, id);
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
        where: { id: intent.id },
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
        await this.projectOrderPaymentStatus(
          tx,
          scopedTenantId,
          intent.orderId,
          OrderPaymentStatus.VOIDED,
          null,
          builders.orderUpdated,
        );
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
      const now = new Date();
      const after = await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: PaymentStatus.FAILED,
          failedAt: now,
          failureReason: input.reason,
        },
      });
      await this.auditLog.record(builders.intentFailed(intent, after), tx);
      await this.projectOrderPaymentStatus(
        tx,
        scopedTenantId,
        intent.orderId,
        OrderPaymentStatus.PAYMENT_FAILED,
        null,
        builders.orderUpdated,
      );
      return this.replay(tx, scopedTenantId, id);
    });
  }

  // ---------------------------------------------------------------- helpers

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
   * Projects a payment transition onto a linked order's paymentStatus. NEVER
   * downgrades a PAID order (CAPTURED is terminal; once paid, an order stays
   * paid), so a later void/fail on a stray intent cannot un-pay it. Audits the
   * change only when the status actually moves.
   */
  private async projectOrderPaymentStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string | null,
    target: OrderPaymentStatus,
    paidAt: Date | null,
    buildAuditEntry?: (before: Order, after: Order) => AuditEntry,
  ): Promise<void> {
    if (!orderId) {
      return;
    }
    const before = await tx.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!before) {
      return;
    }
    // Once PAID, stay PAID: a payment failure/void never un-pays an order.
    if (
      before.paymentStatus === OrderPaymentStatus.PAID &&
      target !== OrderPaymentStatus.PAID
    ) {
      return;
    }
    if (before.paymentStatus === target) {
      return;
    }
    const after = await tx.order.update({
      where: { id: before.id },
      data: {
        paymentStatus: target,
        paidAt: target === OrderPaymentStatus.PAID ? paidAt : before.paidAt,
      },
    });
    if (buildAuditEntry) {
      await this.auditLog.record(buildAuditEntry(before, after), tx);
    }
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
