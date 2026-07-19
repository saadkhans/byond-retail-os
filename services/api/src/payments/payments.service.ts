import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, PaymentStatus } from '@prisma/client';
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
  TransitionRejection,
} from './payments.repository';
import { AuthorizeIntentDto } from './dto/authorize-intent.dto';
import { BindIntentDto } from './dto/bind-intent.dto';
import { CancelIntentDto } from './dto/cancel-intent.dto';
import { CaptureIntentDto } from './dto/capture-intent.dto';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { FailIntentDto } from './dto/fail-intent.dto';
import { QueryCapturesDto } from './dto/query-captures.dto';
import { QueryPaymentIntentsDto } from './dto/query-payment-intents.dto';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class PaymentsService {
  constructor(private readonly repository: PaymentsRepository) {}

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
        'The linked order is already paid; binding this captured intent would double-pay it',
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
        'The checkout session has no order yet; capture once the session has ' +
          'been completed into an order',
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
