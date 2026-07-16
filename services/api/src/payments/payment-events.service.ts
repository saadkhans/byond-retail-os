import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import {
  assertSafeIdempotencyKey,
  assertSafePaymentStrings,
} from './payment-sanitization';
import {
  IngestEventResult,
  PaymentEventsRepository,
  PaymentEventWithRefs,
} from './payment-events.repository';
import { QueryPaymentEventsDto } from './dto/query-payment-events.dto';
import { SimulatePaymentEventDto } from './dto/simulate-payment-event.dto';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

@Injectable()
export class PaymentEventsService {
  constructor(private readonly repository: PaymentEventsRepository) {}

  async ingest(
    tenantId: string,
    dto: SimulatePaymentEventDto,
    actor?: AuditActor,
  ): Promise<PaymentEventWithRefs> {
    assertSafePaymentStrings({
      providerEventId: dto.providerEventId,
      providerRef: dto.providerRef,
    });
    assertSafeIdempotencyKey(dto.idempotencyKey);
    let result: IngestEventResult | 'intent-not-found';
    try {
      result = await this.repository.ingest(
        tenantId,
        {
          intentId: dto.intentId,
          provider: dto.provider,
          providerEventId: dto.providerEventId,
          eventType: dto.eventType,
          providerRef: dto.providerRef,
          idempotencyKey: dto.idempotencyKey,
          actorId: actor?.id,
        },
        (event) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'PaymentEvent',
            entityId: event.id,
            after: event,
            reason: 'Provider event ingested (simulated, normalized fields only)',
          }),
      );
    } catch (error) {
      // Duplicate delivery racing the (tenant, provider, providerEventId) or
      // (tenant, idempotencyKey) unique: replay the recorded event.
      if (prismaErrorCode(error) === 'P2002') {
        const existing = await this.repository.findByProviderEventId(
          tenantId,
          dto.provider,
          dto.providerEventId,
        );
        if (existing) {
          return existing;
        }
      }
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'Referenced payment intent no longer exists',
        );
      }
      throw error;
    }
    if (result === 'intent-not-found') {
      throw new BadRequestException(
        `Payment intent "${dto.intentId}" not found`,
      );
    }
    return result.event;
  }

  async findById(tenantId: string, id: string): Promise<PaymentEventWithRefs> {
    const event = await this.repository.findById(tenantId, id);
    if (!event) {
      throw new NotFoundException(`Payment event "${id}" not found`);
    }
    return event;
  }

  async search(
    tenantId: string,
    query: QueryPaymentEventsDto,
  ): Promise<{
    items: PaymentEventWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.search(tenantId, {
      status: query.status,
      provider: query.provider,
      eventType: query.eventType,
      intentId: query.intentId,
      skip,
      take,
    });
    return { items, total, skip, take };
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
