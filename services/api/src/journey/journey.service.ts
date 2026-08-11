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
  Prisma,
} from '@prisma/client';
import { journeyAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';

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
    if (input.unitId) {
      // TENANT ISOLATION at the data-access boundary: the schema's unit
      // relation is keyed by id alone, so the unit must be resolved
      // within BOTH this tenant and this location before it is written —
      // otherwise a known foreign unit id links a journey across tenants
      // (or across stores of the same tenant).
      const unit = await this.prisma.retailUnit.findFirst({
        where: { tenantId, id: input.unitId, locationId: input.locationId },
        select: { id: true },
      });
      if (!unit) {
        throw new NotFoundException('Unit not found in this store');
      }
    }
    // ATOMIC open: the journey row and its ENTRY event become visible
    // together. If the ENTRY insert failed after the journey committed,
    // an OPEN journey with no ENTRY event would remain and a retry would
    // open a SECOND journey for the same shopper.
    const journey = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customerJourney.create({
        data: {
          tenantId,
          locationId: input.locationId,
          unitId: input.unitId ?? null,
        },
      });
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId: created.id,
          eventType: CustomerJourneyEventType.ENTRY,
          occurredAt: new Date(),
          sourceType: 'MANUAL',
          createdById: actorId ?? null,
        },
      });
      return created;
    });
    return this.detail(tenantId, journey.id);
  }

  /**
   * Serialize every journey mutation behind the per-journey advisory lock
   * and re-check OPEN inside the SAME transaction as the write. Without
   * this, an append that passed the open check could commit after exit()
   * folded the basket and marked the journey RECONCILED — a closed
   * journey with an unaccounted event but a clean status.
   */
  private async withOpenJourney<T>(
    tenantId: string,
    journeyId: string,
    work: (
      tx: Prisma.TransactionClient,
      journey: { id: string; locationId: string; unitId: string | null },
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${journeyAdvisoryLockKey(
        tenantId,
        journeyId,
      )}))::text`;
      const journey = await tx.customerJourney.findFirst({
        where: { tenantId, id: journeyId },
      });
      if (!journey) {
        throw new NotFoundException('Journey not found');
      }
      if (journey.status !== CustomerJourneyStatus.OPEN) {
        throw new ConflictException('Journey is no longer open');
      }
      return work(tx, journey);
    });
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
    // The note is caller free text that persists verbatim and echoes back
    // on every journey read — same reject-on-write screen as the video
    // screening note (Phase 7 policy): no credential- or payment-bearing
    // content ever touches storage. Gated at the service level so every
    // append path is covered.
    if (
      input.note !== undefined &&
      input.note !== null &&
      containsSensitiveFreeText(input.note)
    ) {
      throw new BadRequestException(
        'note must not contain credential- or payment-bearing content',
      );
    }
    await this.withOpenJourney(tenantId, journeyId, async (tx) => {
      // IDEMPOTENT fusion imports: one VIDEO may contribute at most one
      // fusion observation per journey. The dedup keys on (journeyId,
      // videoAssetId) rather than the run id because fusion runs are
      // append-only and freely re-runnable — after a re-run, the "latest
      // run" indirection hands a repeated import a FRESH run id that a
      // run-id-only check would wave through, double-counting one physical
      // observation. Checked under the journey lock, in the same
      // transaction as the insert, so a retry replays instead of doubling
      // the provisional basket.
      if (input.sourceType === 'FUSION_SHADOW' && input.videoAssetId) {
        const existing = await tx.customerJourneyEvent.findFirst({
          where: {
            tenantId,
            journeyId,
            videoAssetId: input.videoAssetId,
            sourceType: 'FUSION_SHADOW',
          },
          select: { id: true },
        });
        if (existing) {
          return;
        }
      }
      let snapshot: { sku: string; name: string } | null = null;
      if (input.productId) {
        const product = await tx.product.findFirst({
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
      await tx.customerJourneyEvent.create({
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
    const journey = await this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      select: { locationId: true, unitId: true },
    });
    if (!journey) {
      throw new NotFoundException('Journey not found');
    }
    // STORE-CONTEXT MATCH: an observation captured in one store must not
    // land in a journey opened in another. The asset must exist in this
    // tenant AND carry the journey's location (and, when both sides pin a
    // unit, the same unit). locationId/unitId are immutable after journey
    // creation, so this pre-append check cannot go stale.
    const asset = await this.prisma.videoAsset.findFirst({
      where: { tenantId, id: videoAssetId, deletedAt: null },
      select: { locationId: true, unitId: true },
    });
    if (!asset) {
      throw new NotFoundException('Video asset not found in this tenant');
    }
    if (asset.locationId === null || asset.locationId !== journey.locationId) {
      throw new ConflictException(
        "the video's store context does not match this journey's store",
      );
    }
    if (journey.unitId && asset.unitId && asset.unitId !== journey.unitId) {
      throw new ConflictException(
        "the video's unit does not match this journey's unit",
      );
    }
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
   *  and settle the journey status — RECONCILED only when clean. Runs
   *  entirely under the per-journey lock so no append can land between
   *  the fold and the status transition. */
  async exit(tenantId: string, journeyId: string, actorId?: string) {
    await this.withOpenJourney(tenantId, journeyId, async (tx) => {
      await tx.customerJourneyEvent.create({
        data: {
          tenantId,
          journeyId,
          eventType: CustomerJourneyEventType.EXIT,
          occurredAt: new Date(),
          sourceType: 'MANUAL',
          createdById: actorId ?? null,
        },
      });
      const events = await tx.customerJourneyEvent.findMany({
        where: { tenantId, journeyId },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      });
      const { issues } = foldBasket(events);
      await tx.customerJourney.update({
        where: { id: journeyId },
        data: {
          status:
            issues.length > 0
              ? CustomerJourneyStatus.REVIEW_REQUIRED
              : CustomerJourneyStatus.RECONCILED,
          endedAt: new Date(),
        },
      });
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
