import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, PaymentRefund, PaymentStatus } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import {
  assertSafeIdempotencyKey,
  assertSafeLast4,
  assertSafePaymentStrings,
} from './payment-sanitization';
import {
  BindRejection,
  CaptureWithIntent,
  CreateIntentRejection,
  IntentResult,
  PaymentIntentDetail,
  PaymentIntentWithRefs,
  PaymentsRepository,
  RefundRejection,
  RefundResult,
  TransitionRejection,
} from './payments.repository';
import {
  REFUND_GATEWAY,
  RefundGateway,
  RefundGatewayResult,
} from './ports/refund-gateway.port';
import { AuthorizeIntentDto } from './dto/authorize-intent.dto';
import { BindIntentDto } from './dto/bind-intent.dto';
import { CancelIntentDto } from './dto/cancel-intent.dto';
import { CaptureIntentDto } from './dto/capture-intent.dto';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { FailIntentDto } from './dto/fail-intent.dto';
import { QueryCapturesDto } from './dto/query-captures.dto';
import { QueryPaymentIntentsDto } from './dto/query-payment-intents.dto';
import { RefundIntentDto } from './dto/refund-intent.dto';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly repository: PaymentsRepository,
    @Inject(REFUND_GATEWAY) private readonly refundGateway: RefundGateway,
  ) {}

  async create(
    tenantId: string,
    dto: CreatePaymentIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentIntentDetail> {
    this.assertSafeIntentInput(dto);
    assertSafeIdempotencyKey(dto.idempotencyKey);
    let result: IntentResult | CreateIntentRejection;
    try {
      result = await this.repository.createIntent(
        tenantId,
        {
          orderId: dto.orderId,
          checkoutSessionId: dto.checkoutSessionId,
          provider: dto.provider,
          amountMinor: dto.amountMinor,
          currencyCode: dto.currencyCode,
          providerRef: dto.providerRef,
          providerCustomerRef: dto.providerCustomerRef,
          instrumentBrand: dto.instrumentBrand,
          instrumentLast4: dto.instrumentLast4,
          instrumentExpiryMonth: dto.instrumentExpiryMonth,
          instrumentExpiryYear: dto.instrumentExpiryYear,
          instrumentWallet: dto.instrumentWallet,
          description: dto.description,
          idempotencyKey: dto.idempotencyKey,
          createdById: actor?.id,
        },
        (intent) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'PaymentIntent',
            entityId: intent.id,
            after: intent,
            reason: 'Payment intent created (provider-abstract, simulated)',
          }),
      );
    } catch (error) {
      // Two creates racing the same idempotency key: the loser's insert hits
      // the (tenantId, idempotencyKey) unique — replay the winner's intent.
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const existing = await this.repository.findIntentByIdempotencyKey(
          tenantId,
          dto.idempotencyKey,
        );
        if (existing) {
          return existing;
        }
      }
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'Referenced order or checkout session no longer exists',
        );
      }
      throw error;
    }
    this.throwCreateRejection(result, dto);
    return (result as IntentResult).intent;
  }

  findById(tenantId: string, id: string): Promise<PaymentIntentDetail> {
    return this.repository.findIntentById(tenantId, id).then((intent) => {
      if (!intent) {
        throw new NotFoundException(`Payment intent "${id}" not found`);
      }
      return intent;
    });
  }

  async search(
    tenantId: string,
    query: QueryPaymentIntentsDto,
  ): Promise<{
    items: PaymentIntentWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.searchIntents(tenantId, {
      status: query.status,
      provider: query.provider,
      orderId: query.orderId,
      checkoutSessionId: query.checkoutSessionId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async searchCaptures(
    tenantId: string,
    query: QueryCapturesDto,
  ): Promise<{
    items: CaptureWithIntent[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.searchCaptures(tenantId, {
      status: query.status,
      intentId: query.intentId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async authorize(
    tenantId: string,
    id: string,
    dto: AuthorizeIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentIntentDetail> {
    assertSafePaymentStrings({ providerRef: dto.providerRef });
    assertSafeIdempotencyKey(dto.idempotencyKey);
    let result: IntentResult | TransitionRejection | null;
    try {
      result = await this.repository.authorize(
        tenantId,
        id,
        {
          providerRef: dto.providerRef,
          idempotencyKey: dto.idempotencyKey,
          actorId: actor?.id,
        },
        {
          intentAuthorized: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.AUTHORIZE,
              entityType: 'PaymentIntent',
              entityId: after.id,
              before,
              after,
              reason: 'Payment authorized (simulated hold)',
            }),
          authorizationCreated: (auth) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'PaymentAuthorization',
              entityId: auth.id,
              after: auth,
              reason: 'Authorization hold recorded (simulated)',
            }),
          orderUpdated: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.UPDATE,
              entityType: 'Order',
              entityId: after.id,
              before,
              after,
              reason: 'Order payment status → AUTHORIZED',
            }),
        },
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const replay = await this.replayFromAuthorizationKey(
          tenantId,
          id,
          dto.idempotencyKey,
        );
        if (replay) {
          return replay;
        }
      }
      throw error;
    }
    return this.resolveTransition(result, id);
  }

  async capture(
    tenantId: string,
    id: string,
    dto: CaptureIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentIntentDetail> {
    assertSafePaymentStrings({ providerRef: dto.providerRef });
    assertSafeIdempotencyKey(dto.idempotencyKey);
    let result: IntentResult | TransitionRejection | null;
    try {
      result = await this.repository.capture(
        tenantId,
        id,
        {
          providerRef: dto.providerRef,
          idempotencyKey: dto.idempotencyKey,
          actorId: actor?.id,
        },
        {
          intentCaptured: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CAPTURE,
              entityType: 'PaymentIntent',
              entityId: after.id,
              before,
              after,
              reason: 'Payment captured (simulated)',
            }),
          captureCreated: (capture) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'PaymentCapture',
              entityId: capture.id,
              after: capture,
              reason: 'Capture recorded (simulated)',
            }),
          reconciliationCreated: (record) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'PaymentReconciliationRecord',
              entityId: record.id,
              after: record,
              reason: 'Reconciliation record seeded (PENDING)',
            }),
          orderPaid: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.UPDATE,
              entityType: 'Order',
              entityId: after.id,
              before,
              after,
              reason: 'Order marked PAID by captured payment',
            }),
          siblingHoldsVoided: (auths) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.VOID,
              entityType: 'PaymentAuthorization',
              entityId: auths.map((auth) => auth.id).join(','),
              before: auths,
              reason:
                'Sibling authorization holds released: their order was paid ' +
                'by another intent’s capture',
            }),
        },
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const replay = await this.replayFromCaptureKey(
          tenantId,
          id,
          dto.idempotencyKey,
        );
        if (replay) {
          return replay;
        }
      }
      throw error;
    }
    return this.resolveTransition(result, id);
  }

  async cancel(
    tenantId: string,
    id: string,
    dto: CancelIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentIntentDetail> {
    const reason = dto.reason?.trim() || undefined;
    assertSafePaymentStrings({ reason });
    const result = await this.repository.cancel(
      tenantId,
      id,
      { reason, actorId: actor?.id },
      {
        intentCancelled: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action:
              after.status === PaymentStatus.VOIDED
                ? AuditAction.VOID
                : AuditAction.CANCEL,
            entityType: 'PaymentIntent',
            entityId: after.id,
            before,
            after,
            reason:
              reason ??
              (after.status === PaymentStatus.VOIDED
                ? 'Payment authorization voided (simulated)'
                : 'Payment intent cancelled'),
          }),
        orderUpdated: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Order',
            entityId: after.id,
            before,
            after,
            reason: 'Order payment status → VOIDED',
          }),
      },
    );
    return this.resolveTransition(result, id);
  }

  async bind(
    tenantId: string,
    id: string,
    dto: BindIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentIntentDetail> {
    // Bind keys get the same sensitive-value screening as every other payment
    // idempotency key (no credentials, no bare CVV/PIN-shaped digits).
    assertSafeIdempotencyKey(dto.idempotencyKey);
    const result = await this.repository.bind(
      tenantId,
      id,
      {
        orderId: dto.orderId,
        checkoutSessionId: dto.checkoutSessionId,
        actorId: actor?.id,
      },
      {
        intentBound: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'PaymentIntent',
            entityId: after.id,
            before,
            after,
            reason: 'Payment intent bound to order/session',
          }),
        orderUpdated: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Order',
            entityId: after.id,
            before,
            after,
            reason: `Order payment status → ${after.paymentStatus} (intent bind)`,
          }),
      },
    );
    return this.resolveBind(result, id, dto);
  }

  async fail(
    tenantId: string,
    id: string,
    dto: FailIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentIntentDetail> {
    const reason = dto.reason?.trim() || undefined;
    assertSafePaymentStrings({ reason });
    const result = await this.repository.fail(
      tenantId,
      id,
      { reason, actorId: actor?.id },
      {
        intentFailed: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.FAIL,
            entityType: 'PaymentIntent',
            entityId: after.id,
            before,
            after,
            reason: reason ?? 'Payment failed (simulated decline)',
          }),
        orderUpdated: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Order',
            entityId: after.id,
            before,
            after,
            reason: 'Order payment status → PAYMENT_FAILED',
          }),
      },
    );
    return this.resolveTransition(result, id);
  }

  // ---------------------------------------------------------------- refund

  /**
   * Phase 27 — return money that was actually taken.
   *
   * Three steps, in this order on purpose:
   *
   *   1. `openRefund` records a PENDING refund under the intent lock, having
   *      already enforced the ceiling and the idempotency key.
   *   2. The owned refund-gateway port is asked to move the money. This
   *      happens OUTSIDE any database transaction, so a slow or hanging
   *      provider cannot hold a transaction (or its locks) open.
   *   3. `settleRefund` records the answer exactly once.
   *
   * If the process dies between 1 and 3 the refund is still there, PENDING,
   * and the linked order says REFUND_PENDING — replaying the request with the
   * same idempotency key picks the original row back up and re-drives
   * settlement, which is why nothing is lost and nothing is paid twice.
   *
   * A gateway that throws is treated as a FAILED refund rather than an
   * exception escaping: the money did not move, the refund says so, and the
   * order goes back to PAID. The adapter's error is never echoed to the caller
   * (a provider error body is exactly the kind of string that can carry
   * material we must not persist).
   */
  async refund(
    tenantId: string,
    intentId: string,
    dto: RefundIntentDto,
    actor?: AuditActor,
  ): Promise<PaymentRefund> {
    const reason = dto.reason?.trim() || undefined;
    assertSafePaymentStrings({ reason, providerRef: dto.providerRef });
    assertSafeIdempotencyKey(dto.idempotencyKey);
    // Redundant with the DTO, deliberately: money arithmetic never rests on
    // transport validation alone.
    if (!Number.isInteger(dto.amountMinor) || dto.amountMinor <= 0) {
      throw new BadRequestException(
        'amountMinor must be a whole number of minor units greater than zero',
      );
    }

    let opened: RefundResult | RefundRejection | null;
    try {
      opened = await this.repository.openRefund(
        tenantId,
        intentId,
        {
          amountMinor: dto.amountMinor,
          reason,
          providerRef: dto.providerRef,
          idempotencyKey: dto.idempotencyKey,
          actorId: actor?.id,
        },
        {
          refundOpened: (refund) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'PaymentRefund',
              entityId: refund.id,
              after: refund,
              reason: reason ?? 'Refund requested (simulated)',
            }),
          orderUpdated: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.UPDATE,
              entityType: 'Order',
              entityId: after.id,
              before,
              after,
              reason: 'Order payment status → REFUND_PENDING',
            }),
        },
      );
    } catch (error) {
      // Two refunds racing the same idempotency key: the loser's insert hits
      // the (tenantId, idempotencyKey) unique. Replay the winner's row rather
      // than surfacing a raw constraint error.
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const existing = await this.repository.searchRefunds(tenantId, {
          intentId,
        });
        const replay = existing.items.find(
          (refund) => refund.idempotencyKey === dto.idempotencyKey,
        );
        if (replay) {
          return this.driveRefundSettlement(tenantId, replay, actor, reason);
        }
      }
      throw error;
    }
    const refund = this.resolveRefund(opened, intentId);
    return this.driveRefundSettlement(tenantId, refund, actor, reason);
  }

  listRefunds(
    tenantId: string,
    filters: { intentId?: string; skip?: number; take?: number },
  ): Promise<{ items: PaymentRefund[]; total: number }> {
    return this.repository.searchRefunds(tenantId, filters);
  }

  /**
   * The intent that actually took an order's money, if any. The returns module
   * asks this instead of reaching into payment tables itself.
   */
  findCapturedIntentForOrder(tenantId: string, orderId: string) {
    return this.repository.findCapturedIntentForOrder(tenantId, orderId);
  }

  /**
   * Calls the gateway for a PENDING refund and records the answer. Safe to
   * call on an already-settled refund (it short-circuits), which is what makes
   * a replayed request a no-op instead of a second payout.
   */
  private async driveRefundSettlement(
    tenantId: string,
    refund: PaymentRefund,
    actor: AuditActor | undefined,
    reason: string | undefined,
  ): Promise<PaymentRefund> {
    if (refund.status !== 'PENDING') {
      return refund;
    }
    let outcome: RefundGatewayResult;
    try {
      outcome = await this.refundGateway.execute({
        refundId: refund.id,
        intentId: refund.intentId,
        provider: await this.providerOf(tenantId, refund.intentId),
        amountMinor: refund.amountMinor,
        currencyCode: refund.currencyCode,
        providerRef: refund.providerRef,
      });
    } catch {
      // The adapter's own error text never reaches storage or the caller.
      outcome = {
        status: 'FAILED',
        failureReason: 'The refund adapter did not complete the request',
      };
    }
    const settled = await this.repository.settleRefund(
      tenantId,
      refund.id,
      outcome,
      {
        refundSettled: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action:
              after.status === 'SUCCEEDED'
                ? AuditAction.UPDATE
                : AuditAction.FAIL,
            entityType: 'PaymentRefund',
            entityId: after.id,
            before,
            after,
            reason:
              after.status === 'SUCCEEDED'
                ? (reason ?? 'Refund settled (simulated)')
                : 'Refund declined by the refund adapter',
          }),
        orderUpdated: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'Order',
            entityId: after.id,
            before,
            after,
            reason: `Order payment status → ${after.paymentStatus} (refund settlement)`,
          }),
      },
    );
    if (!settled) {
      throw new NotFoundException(`Refund "${refund.id}" not found`);
    }
    return settled.refund;
  }

  private async providerOf(
    tenantId: string,
    intentId: string,
  ): Promise<string> {
    const intent = await this.repository.findIntentById(tenantId, intentId);
    return intent?.provider ?? 'SIMULATED';
  }

  private resolveRefund(
    result: RefundResult | RefundRejection | null,
    intentId: string,
  ): PaymentRefund {
    if (result === null) {
      throw new NotFoundException(`Payment intent "${intentId}" not found`);
    }
    if (result === 'intent-not-captured') {
      throw new ConflictException(
        'Only a CAPTURED payment can be refunded. This intent is in a state ' +
          'where no money was ever taken (CREATED/REQUIRES_AUTHORIZATION/' +
          'AUTHORIZED/CAPTURE_PENDING, or a terminal CANCELLED/FAILED/VOIDED/' +
          'EXPIRED), so there is nothing to return.',
      );
    }
    if (result === 'refund-amount-invalid') {
      throw new BadRequestException(
        'amountMinor must be a whole number of minor units greater than zero',
      );
    }
    if (result === 'refund-exceeds-capture') {
      // The remaining amount is deliberately NOT echoed: the captured payment
      // is the authority, and repeating a rejected figure back invites a
      // caller to treat the ceiling as negotiable.
      throw new ConflictException(
        'Refund rejected: it would return more than this payment captured, ' +
          'counting refunds already settled or in flight',
      );
    }
    if (result === 'idempotency-key-conflict') {
      throw new ConflictException(
        'This idempotency key was already used to refund a different payment intent',
      );
    }
    return result.refund;
  }

  // --------------------------------------------------------------- helpers

  private assertSafeIntentInput(dto: CreatePaymentIntentDto): void {
    assertSafePaymentStrings({
      providerRef: dto.providerRef,
      providerCustomerRef: dto.providerCustomerRef,
      instrumentBrand: dto.instrumentBrand,
      instrumentWallet: dto.instrumentWallet,
      description: dto.description,
    });
    assertSafeLast4(dto.instrumentLast4);
  }

  private throwCreateRejection(
    result: IntentResult | CreateIntentRejection,
    dto: CreatePaymentIntentDto,
  ): void {
    if (result === 'order-not-found') {
      throw new BadRequestException(`Order "${dto.orderId}" not found`);
    }
    if (result === 'session-not-found') {
      throw new BadRequestException(
        `Checkout session "${dto.checkoutSessionId}" not found`,
      );
    }
    if (result === 'order-session-mismatch') {
      throw new BadRequestException(
        'The order and checkout session refer to different checkouts',
      );
    }
    if (result === 'order-amount-mismatch') {
      // The amount is deliberately NOT echoed: the order is the authority,
      // and repeating a rejected figure back invites a caller to treat the
      // error as negotiable.
      throw new ConflictException(
        'The intent amount and currency must match the linked order’s total',
      );
    }
  }

  private async replayFromAuthorizationKey(
    tenantId: string,
    intentId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentDetail | null> {
    const existing = await this.repository.findAuthorizationByIdempotencyKey(
      tenantId,
      idempotencyKey,
    );
    if (!existing) {
      return null;
    }
    if (existing.intentId !== intentId) {
      throw new ConflictException(
        'This idempotency key was already used to authorize a different payment intent',
      );
    }
    return this.repository.findIntentById(tenantId, intentId);
  }

  private async replayFromCaptureKey(
    tenantId: string,
    intentId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentDetail | null> {
    const existing = await this.repository.findCaptureByIdempotencyKey(
      tenantId,
      idempotencyKey,
    );
    if (!existing) {
      return null;
    }
    if (existing.intentId !== intentId) {
      throw new ConflictException(
        'This idempotency key was already used to capture a different payment intent',
      );
    }
    return this.repository.findIntentById(tenantId, intentId);
  }

  private resolveBind(
    result: IntentResult | BindRejection | null,
    id: string,
    dto: BindIntentDto,
  ): PaymentIntentDetail {
    if (result === null) {
      throw new NotFoundException(`Payment intent "${id}" not found`);
    }
    if (result === 'bind-requires-target') {
      throw new BadRequestException(
        'Provide an orderId and/or checkoutSessionId to bind to',
      );
    }
    if (result === 'order-not-found') {
      throw new BadRequestException(`Order "${dto.orderId}" not found`);
    }
    if (result === 'session-not-found') {
      throw new BadRequestException(
        `Checkout session "${dto.checkoutSessionId}" not found`,
      );
    }
    if (result === 'order-session-mismatch') {
      throw new BadRequestException(
        'The order and checkout session refer to different checkouts',
      );
    }
    if (result === 'already-bound') {
      throw new ConflictException(
        'This intent is already bound to a different order or checkout session',
      );
    }
    if (result === 'order-cancelled') {
      throw new ConflictException(
        'The linked order is cancelled; the intent cannot project onto it',
      );
    }
    if (result === 'order-already-paid') {
      throw new ConflictException(
        'The order is already paid; a new payment intent cannot be bound to it',
      );
    }
    return result.intent;
  }

  private resolveTransition(
    result: IntentResult | TransitionRejection | null,
    id: string,
  ): PaymentIntentDetail {
    if (result === null) {
      throw new NotFoundException(`Payment intent "${id}" not found`);
    }
    if (result === 'terminal-blocked') {
      throw new ConflictException(
        'Payment intent is in a terminal state (CAPTURED/FAILED/CANCELLED/VOIDED/EXPIRED) and cannot change again',
      );
    }
    if (result === 'invalid-state') {
      throw new ConflictException(
        'The requested transition is not legal from the intent’s current state',
      );
    }
    if (result === 'idempotency-key-conflict') {
      throw new ConflictException(
        'This idempotency key was already used for a different payment operation or intent',
      );
    }
    if (result === 'order-cancelled') {
      throw new ConflictException(
        'The linked order is cancelled; it cannot be authorized or captured',
      );
    }
    if (result === 'order-already-paid') {
      throw new ConflictException(
        'The linked order is already paid; capturing again would double-capture it',
      );
    }
    if (result === 'order-not-ready') {
      throw new ConflictException(
        'Payment intent must be bound to an order before financial transition.',
      );
    }
    return result.intent;
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityType' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
