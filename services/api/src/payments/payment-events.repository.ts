import { Injectable } from '@nestjs/common';
import {
  PaymentEventStatus,
  PaymentEventType,
  PaymentProvider,
  Prisma,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { paymentEventAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

export const EVENT_INCLUDE = {
  intent: { select: { id: true, status: true } },
} satisfies Prisma.PaymentEventInclude;

export type PaymentEventWithRefs = Prisma.PaymentEventGetPayload<{
  include: typeof EVENT_INCLUDE;
}>;

export type IngestEventInput = {
  intentId?: string;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentEventType;
  providerRef?: string;
  idempotencyKey?: string;
  actorId?: string;
};

export type IngestEventRejection =
  | 'intent-not-found'
  // The referenced intent belongs to a DIFFERENT provider than the event —
  // a SIMULATED event must never attach to a MANUAL intent (and vice versa).
  | 'intent-provider-mismatch';

export interface IngestEventResult {
  event: PaymentEventWithRefs;
  replayed: boolean;
}

@Injectable()
export class PaymentEventsRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  /**
   * Ingests a normalized provider event. NO raw provider payload is stored —
   * only the normalized fields. Deduplicated per (tenant, provider,
   * providerEventId): a re-delivered event replays the original record instead
   * of inserting a duplicate. Runs under the per-event advisory lock so two
   * concurrent deliveries of the same event cannot both insert. UNKNOWN events
   * are safely recorded as IGNORED (never drive the intent state machine —
   * this is a recording foundation, not a live webhook processor).
   */
  ingest(
    tenantId: string,
    data: IngestEventInput,
    buildAuditEntry: (event: PaymentEventWithRefs) => AuditEntry,
  ): Promise<IngestEventResult | IngestEventRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentEventAdvisoryLockKey(
        scopedTenantId,
        data.provider,
        data.providerEventId,
      )}))`;
      const existing = await tx.paymentEvent.findFirst({
        where: {
          tenantId: scopedTenantId,
          provider: data.provider,
          providerEventId: data.providerEventId,
        },
        include: EVENT_INCLUDE,
      });
      if (existing) {
        // Duplicate provider event: idempotent replay, no new row/audit.
        return { event: existing, replayed: true };
      }
      if (data.intentId) {
        const intent = await tx.paymentIntent.findFirst({
          where: { id: data.intentId, tenantId: scopedTenantId },
          select: { id: true, provider: true },
        });
        if (!intent) {
          return 'intent-not-found' as const;
        }
        // A provider's event must not contaminate another provider's intent
        // history (e.g. a SIMULATED event attaching to a MANUAL intent).
        if (intent.provider !== data.provider) {
          return 'intent-provider-mismatch' as const;
        }
      }
      const status =
        data.eventType === PaymentEventType.UNKNOWN
          ? PaymentEventStatus.IGNORED
          : PaymentEventStatus.RECEIVED;
      const event = await tx.paymentEvent.create({
        data: {
          tenantId: scopedTenantId,
          intentId: data.intentId,
          provider: data.provider,
          providerEventId: data.providerEventId,
          eventType: data.eventType,
          status,
          providerRef: data.providerRef,
          idempotencyKey: data.idempotencyKey,
          createdById: data.actorId,
        },
        include: EVENT_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(event), tx);
      return { event, replayed: false };
    });
  }

  /** Replay lookup for the dedupe/idempotency P2002 race. */
  findByProviderEventId(
    tenantId: string,
    provider: PaymentProvider,
    providerEventId: string,
  ): Promise<PaymentEventWithRefs | null> {
    return this.prisma.paymentEvent.findFirst({
      where: this.scope(tenantId, { provider, providerEventId }),
      include: EVENT_INCLUDE,
    });
  }

  /**
   * Lookup for the (tenantId, idempotencyKey) unique P2002: an idempotency key
   * reused with a DIFFERENT provider event is a controlled conflict, not a
   * replay (the dedupe replay only covers a matching provider/providerEventId).
   */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<PaymentEventWithRefs | null> {
    return this.prisma.paymentEvent.findFirst({
      where: this.scope(tenantId, { idempotencyKey }),
      include: EVENT_INCLUDE,
    });
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<PaymentEventWithRefs | null> {
    return this.prisma.paymentEvent.findFirst({
      where: this.scope(tenantId, { id }),
      include: EVENT_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: {
      status?: PaymentEventStatus;
      provider?: PaymentProvider;
      eventType?: PaymentEventType;
      intentId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: PaymentEventWithRefs[]; total: number }> {
    const where: Prisma.PaymentEventWhereInput = this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.provider) {
      where.provider = filters.provider;
    }
    if (filters.eventType) {
      where.eventType = filters.eventType;
    }
    if (filters.intentId) {
      where.intentId = filters.intentId;
    }
    const [items, total] = await Promise.all([
      this.prisma.paymentEvent.findMany({
        where,
        include: EVENT_INCLUDE,
        // id is the deterministic tie-breaker over millisecond receivedAt.
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.paymentEvent.count({ where }),
    ]);
    return { items, total };
  }
}
