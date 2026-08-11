import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  CustomerJourneyEventType,
  CustomerJourneyStatus,
} from '@prisma/client';
import { JourneyService, foldBasket } from './journey.service';

const TENANT = 'tenant-1';

type EventRow = {
  id: string;
  eventType: CustomerJourneyEventType;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
};

function event(
  eventType: CustomerJourneyEventType,
  productId: string | null = null,
  quantity = 1,
): EventRow {
  return {
    id: `e-${Math.abs(quantity)}-${eventType}-${productId ?? 'none'}`,
    eventType,
    productId,
    sku: productId ? `SKU-${productId}` : null,
    productName: productId ? `Product ${productId}` : null,
    quantity,
  };
}

describe('foldBasket (provisional basket = pure fold over events)', () => {
  it('accumulates pickups and subtracts returns per product', () => {
    const { basket, issues } = foldBasket([
      event(CustomerJourneyEventType.ENTRY),
      event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 2),
      event(CustomerJourneyEventType.PRODUCT_PICKUP, 'b', 1),
      event(CustomerJourneyEventType.PRODUCT_RETURN, 'a', 1),
      event(CustomerJourneyEventType.EXIT),
    ]);
    expect(basket).toEqual([
      expect.objectContaining({ productId: 'a', quantity: 1 }),
      expect.objectContaining({ productId: 'b', quantity: 1 }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('flags REVIEW_REQUIRED events, unknown products, and returns without pickups', () => {
    const { basket, issues } = foldBasket([
      event(CustomerJourneyEventType.REVIEW_REQUIRED),
      event(CustomerJourneyEventType.PRODUCT_RETURN, 'x', 1),
    ]);
    expect(basket).toEqual([expect.objectContaining({ productId: 'x', quantity: -1 })]);
    const kinds = issues.map((issue) => issue.kind).sort();
    expect(kinds).toEqual(['NEGATIVE_QUANTITY', 'RETURN_WITHOUT_PICKUP', 'REVIEW_EVENT']);
  });

  it('drops fully-returned lines from the basket without losing the audit trail', () => {
    const { basket, issues } = foldBasket([
      event(CustomerJourneyEventType.PRODUCT_PICKUP, 'a', 1),
      event(CustomerJourneyEventType.PRODUCT_RETURN, 'a', 1),
    ]);
    expect(basket).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });
});

/**
 * The prisma mock exposes ONLY journey tables + read-only product/location
 * lookups — any attempt by the service to touch checkout sessions, orders,
 * payments, or inventory would throw immediately (shadow-mode guarantee).
 */
function buildService(overrides: {
  journeyStatus?: CustomerJourneyStatus;
  fusionRun?: Record<string, unknown> | null;
} = {}) {
  const createdEvents: Record<string, unknown>[] = [];
  const journeyRow = {
    id: 'j-1',
    tenantId: TENANT,
    locationId: 'store-1',
    unitId: null,
    status: overrides.journeyStatus ?? CustomerJourneyStatus.OPEN,
    startedAt: new Date(),
    endedAt: null,
    events: [] as unknown[],
  };
  const prisma = {
    location: { findFirst: jest.fn(async () => ({ id: 'store-1' })) },
    product: {
      findFirst: jest.fn(async () => ({ sku: 'SKU-A', name: 'Product A' })),
    },
    customerJourney: {
      create: jest.fn(async () => journeyRow),
      findFirst: jest.fn(async () => journeyRow),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(journeyRow, args.data);
        return journeyRow;
      }),
      findMany: jest.fn(async () => []),
    },
    customerJourneyEvent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `e-${createdEvents.length + 1}`, ...args.data };
        createdEvents.push(row);
        journeyRow.events.push(row);
        return row;
      }),
    },
    pickupFusionRun: {
      findFirst: jest.fn(async () => overrides.fusionRun ?? null),
    },
  };
  return {
    service: new JourneyService(prisma as never),
    prisma,
    createdEvents,
    journeyRow,
  };
}

describe('JourneyService', () => {
  it('create opens the journey with an ENTRY event', async () => {
    const { service, createdEvents } = buildService();
    await service.create(TENANT, { locationId: 'store-1' }, 'user-1');
    expect(createdEvents[0]).toMatchObject({
      eventType: CustomerJourneyEventType.ENTRY,
    });
  });

  it('append rejects on a closed journey (append-only stream stays coherent)', async () => {
    const { service } = buildService({
      journeyStatus: CustomerJourneyStatus.RECONCILED,
    });
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.SHELF_INTERACTION,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('pickup/return events REQUIRE a product; unidentified goes to REVIEW_REQUIRED', async () => {
    const { service } = buildService();
    await expect(
      service.appendEvent(TENANT, 'j-1', {
        eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exit reconciles CLEAN journeys to RECONCILED', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.RECONCILED);
  });

  it('exit routes journeys with unresolved issues to REVIEW_REQUIRED', async () => {
    const { service, journeyRow } = buildService();
    await service.appendEvent(TENANT, 'j-1', {
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      note: 'unidentified pickup',
    });
    await service.exit(TENANT, 'j-1');
    expect(journeyRow.status).toBe(CustomerJourneyStatus.REVIEW_REQUIRED);
  });

  it('fusion-run import maps AUTO_PROPOSE to a product event and anything else to review', async () => {
    const autoRun = {
      id: 'run-1',
      policy: 'AUTO_PROPOSE',
      fusedTopScore: 0.51,
      fusedTopSku: 'SKU-A',
      evidence: {
        detector: { events: [{ kind: 'PICKUP' }] },
        fused: [{ productId: 'prod-a', sku: 'SKU-A', productName: 'Product A' }],
      },
    };
    const { service, createdEvents } = buildService({ fusionRun: autoRun });
    await service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(createdEvents[0]).toMatchObject({
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      sourceType: 'FUSION_SHADOW',
      fusionRunId: 'run-1',
    });

    const reviewRun = { ...autoRun, policy: 'NEEDS_HUMAN_REVIEW' };
    const second = buildService({ fusionRun: reviewRun });
    await second.service.appendFromFusionRun(TENANT, 'j-1', 'asset-1');
    expect(second.createdEvents[0]).toMatchObject({
      eventType: CustomerJourneyEventType.REVIEW_REQUIRED,
      sourceType: 'FUSION_SHADOW',
    });
  });
});
