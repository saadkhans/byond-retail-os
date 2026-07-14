import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  CheckoutSessionStatus,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import {
  CheckoutSessionDetail,
  CheckoutSessionsRepository,
  CheckoutSessionWithRefs,
  CompletedOrder,
  EvidenceRefs,
} from './checkout-sessions.repository';
import { AddSessionLineDto } from './dto/add-session-line.dto';
import { CompleteSessionDto } from './dto/complete-session.dto';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { QueryCheckoutSessionsDto } from './dto/query-checkout-sessions.dto';
import { UpdateSessionStatusDto } from './dto/update-session-status.dto';
import { UpdateSessionLineDto } from './dto/update-session-line.dto';
import { CheckoutSessionLine } from '@prisma/client';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/** Extracts the evidence/source lineage subset of a mutation DTO. */
function evidenceRefs(dto: EvidenceRefs): EvidenceRefs {
  return {
    sourceType: dto.sourceType,
    sourceId: dto.sourceId,
    evidenceBundleId: dto.evidenceBundleId,
    visionEventId: dto.visionEventId,
    vlmReviewId: dto.vlmReviewId,
    evidenceScore: dto.evidenceScore,
    evidenceQuality: dto.evidenceQuality,
    reasonCodes: dto.reasonCodes,
  };
}

@Injectable()
export class CheckoutSessionsService {
  constructor(
    private readonly sessionsRepository: CheckoutSessionsRepository,
  ) {}

  async create(
    tenantId: string,
    dto: CreateCheckoutSessionDto,
    actor?: AuditActor,
  ): Promise<CheckoutSessionDetail> {
    let result: Awaited<
      ReturnType<CheckoutSessionsRepository['create']>
    >;
    try {
      result = await this.sessionsRepository.create(
        tenantId,
        {
          ...evidenceRefs(dto),
          locationId: dto.locationId,
          unitId: dto.unitId,
          deviceId: dto.deviceId,
          idempotencyKey: dto.idempotencyKey,
          createdById: actor?.id,
        },
        (session) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'CheckoutSession',
            entityId: session.id,
            after: session,
            reason: 'Checkout session opened',
          }),
      );
    } catch (error) {
      // Two firsts racing the same idempotency key: the loser's insert hits
      // the (tenantId, idempotencyKey) unique — replay the winner's session.
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const existing = await this.sessionsRepository.findByIdempotencyKey(
          tenantId,
          dto.idempotencyKey,
        );
        if (existing) {
          return existing;
        }
      }
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'Referenced store, unit, or device no longer exists',
        );
      }
      throw error;
    }
    if (result === 'location-not-found') {
      throw new BadRequestException(`Store "${dto.locationId}" not found`);
    }
    if (result === 'unit-not-found') {
      throw new BadRequestException(`Unit "${dto.unitId}" not found`);
    }
    if (result === 'unit-location-mismatch') {
      throw new BadRequestException(
        `Unit "${dto.unitId}" does not belong to store "${dto.locationId}"`,
      );
    }
    if (result === 'device-not-found') {
      throw new BadRequestException(`Device "${dto.deviceId}" not found`);
    }
    return result.session;
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<CheckoutSessionDetail> {
    const session = await this.sessionsRepository.findById(tenantId, id);
    if (!session) {
      throw new NotFoundException(`Checkout session "${id}" not found`);
    }
    return session;
  }

  async search(
    tenantId: string,
    query: QueryCheckoutSessionsDto,
  ): Promise<{
    items: CheckoutSessionWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.sessionsRepository.search(tenantId, {
      status: query.status,
      locationId: query.locationId,
      unitId: query.unitId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async updateStatus(
    tenantId: string,
    id: string,
    dto: UpdateSessionStatusDto,
    actor?: AuditActor,
  ): Promise<CheckoutSessionDetail> {
    const result = await this.sessionsRepository.updateStatus(
      tenantId,
      id,
      dto.status,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action:
            dto.status === CheckoutSessionStatus.CANCELLED
              ? AuditAction.CANCEL
              : dto.status === CheckoutSessionStatus.EXPIRED
                ? AuditAction.EXPIRE
                : AuditAction.UPDATE,
          entityType: 'CheckoutSession',
          entityId: after.id,
          before,
          after,
          reason: dto.reason ?? `Checkout session → ${dto.status}`,
        }),
    );
    if (result === null) {
      throw new NotFoundException(`Checkout session "${id}" not found`);
    }
    if (result === 'terminal-blocked') {
      throw new ConflictException(
        'Session is in a terminal state (COMPLETED/CANCELLED/EXPIRED) and cannot change again',
      );
    }
    if (result === 'transition-blocked') {
      throw new ConflictException(
        `Transition to ${dto.status} is not a legal lifecycle step for this session`,
      );
    }
    return result;
  }

  async addLine(
    tenantId: string,
    sessionId: string,
    dto: AddSessionLineDto,
    actor?: AuditActor,
  ): Promise<CheckoutSessionLine> {
    let result: Awaited<ReturnType<CheckoutSessionsRepository['addLine']>>;
    try {
      result = await this.sessionsRepository.addLine(
        tenantId,
        sessionId,
        {
          ...evidenceRefs(dto),
          productId: dto.productId,
          quantity: dto.quantity,
          idempotencyKey: dto.idempotencyKey,
          createdById: actor?.id,
        },
        (line) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'CheckoutSessionLine',
            entityId: line.id,
            after: line,
            reason: 'Basket line added',
          }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          'The session already has a line for this product (update it ' +
            'instead), or the idempotency key was already used elsewhere',
        );
      }
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'Referenced session or product no longer exists',
        );
      }
      throw error;
    }
    this.throwLineRejection(result, sessionId, dto.productId);
    return (result as { line: CheckoutSessionLine }).line;
  }

  async updateLine(
    tenantId: string,
    sessionId: string,
    lineId: string,
    dto: UpdateSessionLineDto,
    actor?: AuditActor,
  ): Promise<CheckoutSessionLine> {
    const refs = evidenceRefs(dto);
    const hasChange =
      dto.quantity !== undefined ||
      Object.values(refs).some((value) => value !== undefined);
    if (!hasChange) {
      throw new BadRequestException('No fields to update');
    }
    const result = await this.sessionsRepository.updateLine(
      tenantId,
      sessionId,
      lineId,
      { ...refs, quantity: dto.quantity },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'CheckoutSessionLine',
          entityId: after.id,
          before,
          after,
          reason: 'Basket line updated',
        }),
    );
    this.throwLineRejection(result, sessionId, undefined, lineId);
    return result as CheckoutSessionLine;
  }

  async removeLine(
    tenantId: string,
    sessionId: string,
    lineId: string,
    actor?: AuditActor,
  ): Promise<void> {
    const result = await this.sessionsRepository.removeLine(
      tenantId,
      sessionId,
      lineId,
      (deleted) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.DELETE,
          entityType: 'CheckoutSessionLine',
          entityId: deleted.id,
          before: deleted,
          reason: 'Basket line removed',
        }),
    );
    this.throwLineRejection(result, sessionId, undefined, lineId);
  }

  async complete(
    tenantId: string,
    sessionId: string,
    dto: CompleteSessionDto,
    actor?: AuditActor,
  ): Promise<CompletedOrder> {
    const result = await this.sessionsRepository.complete(
      tenantId,
      sessionId,
      { idempotencyKey: dto.idempotencyKey, createdById: actor?.id },
      {
        sessionCompleted: (before, after) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.COMPLETE,
            entityType: 'CheckoutSession',
            entityId: after.id,
            before,
            after,
            reason: 'Checkout session completed into an order',
          }),
        orderCreated: (order) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'Order',
            entityId: order.id,
            after: order,
            reason: `Order ${order.orderNumber} created from checkout session`,
          }),
        stockConsumed: (movement, level, line) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.STOCK_ADJUSTMENT,
            entityType: 'InventoryMovement',
            entityId: movement.id,
            after: { movement, quantityAfter: level.quantity },
            reason: `Stock consumed for SKU "${line.sku}" by checkout completion`,
          }),
      },
    );
    if (result === 'session-not-found') {
      throw new NotFoundException(
        `Checkout session "${sessionId}" not found`,
      );
    }
    if (result === 'already-completed') {
      throw new ConflictException(
        'Session is already completed; repeat the original request with ' +
          'its idempotency key to retrieve the order',
      );
    }
    if (result === 'session-terminal') {
      throw new ConflictException(
        'Session is cancelled or expired and cannot be completed',
      );
    }
    if (result === 'empty-session') {
      throw new ConflictException(
        'Session has no basket lines; add at least one line before completing',
      );
    }
    if (typeof result === 'object' && 'stockFailure' in result) {
      if (result.stockFailure === 'insufficient-stock') {
        throw new ConflictException(
          `Insufficient stock for SKU "${result.sku}"; the completion was ` +
            'rolled back and no order was created',
        );
      }
      if (result.stockFailure === 'product-archived') {
        throw new ConflictException(
          `Product with SKU "${result.sku}" is archived and cannot be sold; ` +
            'the completion was rolled back',
        );
      }
      throw new ConflictException(
        `Stock for SKU "${result.sku}" could not be consumed ` +
          `(${result.stockFailure}); the completion was rolled back`,
      );
    }
    return result.order;
  }

  private throwLineRejection(
    result: unknown,
    sessionId: string,
    productId?: string,
    lineId?: string,
  ): void {
    if (result === 'session-not-found') {
      throw new NotFoundException(
        `Checkout session "${sessionId}" not found`,
      );
    }
    if (result === 'session-terminal') {
      throw new ConflictException(
        'Session is in a terminal state (COMPLETED/CANCELLED/EXPIRED); its basket can no longer change',
      );
    }
    if (result === 'product-not-found') {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
    if (result === 'product-not-saleable') {
      throw new ConflictException(
        `Product "${productId}" is not ACTIVE and cannot be added to a basket`,
      );
    }
    if (result === 'line-not-found') {
      throw new NotFoundException(
        `Line "${lineId}" not found on session "${sessionId}"`,
      );
    }
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
