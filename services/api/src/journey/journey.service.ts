import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  FusionPolicyResult,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

export interface JourneyDetail {
  id: string;
  locationId: string;
  unitId: string | null;
  status: CustomerJourneyStatus;
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
  }[];
  basket: ProvisionalBasketLine[];
  issues: JourneyIssue[];
}

/** Pure basket fold — exported for direct testing. */
export function foldBasket(
  events: {
    id: string;
    eventType: CustomerJourneyEventType;
    productId: string | null;
    sku: string | null;
    productName: string | null;
    quantity: number;
  }[],
): { basket: ProvisionalBasketLine[]; issues: JourneyIssue[] } {
  const lines = new Map<string, ProvisionalBasketLine>();
  const issues: JourneyIssue[] = [];
  for (const event of events) {
    if (event.eventType === CustomerJourneyEventType.REVIEW_REQUIRED) {
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
    }
    lines.set(event.productId, line);
  }
  for (const line of lines.values()) {
    if (line.quantity < 0) {
      issues.push({
        kind: 'NEGATIVE_QUANTITY',
        detail: `${line.sku ?? line.productId} folded to ${line.quantity}`,
      });
    }
  }
  return {
    basket: [...lines.values()].filter((line) => line.quantity !== 0),
    issues,
  };
}

@Injectable()
export class JourneyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    input: { locationId: string; unitId?: string | null },
    actorId?: string,
  ) {
    const location = await this.prisma.location.findFirst({
      where: { tenantId, id: input.locationId },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException('Store not found in this tenant');
    }
    const journey = await this.prisma.customerJourney.create({
      data: {
        tenantId,
        locationId: input.locationId,
        unitId: input.unitId ?? null,
      },
    });
    await this.prisma.customerJourneyEvent.create({
      data: {
        tenantId,
        journeyId: journey.id,
        eventType: CustomerJourneyEventType.ENTRY,
        occurredAt: new Date(),
        sourceType: 'MANUAL',
        createdById: actorId ?? null,
      },
    });
    return this.detail(tenantId, journey.id);
  }

  private async requireOpen(tenantId: string, journeyId: string) {
    const journey = await this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
    });
    if (!journey) {
      throw new NotFoundException('Journey not found');
    }
    if (journey.status !== CustomerJourneyStatus.OPEN) {
      throw new ConflictException('Journey is no longer open');
    }
    return journey;
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
    },
    actorId?: string,
  ) {
    await this.requireOpen(tenantId, journeyId);
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
    let snapshot: { sku: string; name: string } | null = null;
    if (input.productId) {
      const product = await this.prisma.product.findFirst({
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
    await this.prisma.customerJourneyEvent.create({
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
  ) {
    await this.requireOpen(tenantId, journeyId);
    const run = await this.prisma.pickupFusionRun.findFirst({
      where: { tenantId, videoAssetId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!run) {
      throw new NotFoundException('No fusion run exists for that video');
    }
    const evidence = run.evidence as {
      detector?: { events?: { kind?: string }[] };
      fused?: { productId: string; sku: string; productName: string }[];
    };
    const detectedKind = evidence.detector?.events?.[0]?.kind;
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
          productId: top.productId,
          matchScore: run.fusedTopScore,
          sourceType: 'FUSION_SHADOW',
          videoAssetId,
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
        sourceType: 'FUSION_SHADOW',
        videoAssetId,
        fusionRunId: run.id,
        matchScore: run.fusedTopScore,
        note: `policy ${run.policy}${run.fusedTopSku ? ` · top ${run.fusedTopSku}` : ''}`,
      },
      actorId,
    );
  }

  /** EXIT + reconciliation: fold the basket, surface unresolved issues,
   *  and settle the journey status — RECONCILED only when clean. */
  async exit(tenantId: string, journeyId: string, actorId?: string) {
    await this.requireOpen(tenantId, journeyId);
    await this.prisma.customerJourneyEvent.create({
      data: {
        tenantId,
        journeyId,
        eventType: CustomerJourneyEventType.EXIT,
        occurredAt: new Date(),
        sourceType: 'MANUAL',
        createdById: actorId ?? null,
      },
    });
    const detail = await this.detail(tenantId, journeyId);
    const status =
      detail.issues.length > 0
        ? CustomerJourneyStatus.REVIEW_REQUIRED
        : CustomerJourneyStatus.RECONCILED;
    await this.prisma.customerJourney.update({
      where: { id: journeyId },
      data: { status, endedAt: new Date() },
    });
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
      startedAt: journey.startedAt,
      endedAt: journey.endedAt,
      eventCount: journey._count.events,
    }));
  }

  async detail(tenantId: string, journeyId: string): Promise<JourneyDetail> {
    const journey = await this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      include: {
        events: { orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!journey) {
      throw new NotFoundException('Journey not found');
    }
    const { basket, issues } = foldBasket(journey.events);
    return {
      id: journey.id,
      locationId: journey.locationId,
      unitId: journey.unitId,
      status: journey.status,
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
      })),
      basket,
      issues,
    };
  }
}
