import { Injectable } from '@nestjs/common';
import {
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  Prisma,
  ShopperStatus,
  StoreEntryTokenStatus,
  StoreFlowAutonomyLevel,
  StoreFlowProjectionOutcome,
  StoreFlowSettlementStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PolicyCandidate } from './store-flow.logic';

/**
 * Phase 26 — every database access the store flow makes.
 *
 * TENANT ISOLATION is enforced here, not by callers: every query in this file
 * carries `tenantId` in its WHERE clause, and every write addresses its row by
 * a composite `{ id, tenantId }` key so a known foreign id can never reach
 * another tenant's data even if a caller passes one.
 */

export interface StoreFlowJourneyRow {
  id: string;
  tenantId: string;
  locationId: string;
  unitId: string | null;
  status: CustomerJourneyStatus;
  shopperId: string | null;
  checkoutSessionId: string | null;
  orderId: string | null;
  settlementStatus: StoreFlowSettlementStatus;
  startedAt: Date;
  endedAt: Date | null;
}

export interface ObservationRow {
  id: string;
  journeyId: string;
  eventType: CustomerJourneyEventType;
  occurredAt: Date;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  quantity: number;
  matchScore: number | null;
  sourceType: string;
  fusionRunId: string | null;
  videoAssetId: string | null;
}

export interface ProjectionRow {
  id: string;
  journeyId: string;
  journeyEventId: string;
  outcome: StoreFlowProjectionOutcome;
  reasonCode: string;
  visionEventId: string | null;
  autonomyLevel: StoreFlowAutonomyLevel;
  confidence: number | null;
  createdAt: Date;
}

export interface EntryTokenRow {
  id: string;
  tenantId: string;
  locationId: string;
  unitId: string;
  shopperId: string | null;
  tokenHash: string;
  status: StoreEntryTokenStatus;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedJourneyId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const JOURNEY_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  unitId: true,
  status: true,
  shopperId: true,
  checkoutSessionId: true,
  orderId: true,
  settlementStatus: true,
  startedAt: true,
  endedAt: true,
} as const;

const OBSERVATION_SELECT = {
  id: true,
  journeyId: true,
  eventType: true,
  occurredAt: true,
  productId: true,
  sku: true,
  productName: true,
  quantity: true,
  matchScore: true,
  sourceType: true,
  fusionRunId: true,
  videoAssetId: true,
} as const;

const PROJECTION_SELECT = {
  id: true,
  journeyId: true,
  journeyEventId: true,
  outcome: true,
  reasonCode: true,
  visionEventId: true,
  autonomyLevel: true,
  confidence: true,
  createdAt: true,
} as const;

/**
 * The entry-token columns safe to return from an API. `tokenHash` is
 * deliberately absent: the digest is an authentication secret's only stored
 * form and must never leave the data-access layer.
 */
const ENTRY_TOKEN_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  unitId: true,
  shopperId: true,
  status: true,
  expiresAt: true,
  redeemedAt: true,
  redeemedJourneyId: true,
  revokedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class StoreFlowRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  /**
   * Every policy that could apply at one store: the store's own and the
   * tenant-wide default. Resolution between them is pure and lives in
   * store-flow.logic.ts.
   */
  async policyCandidates(
    tenantId: string,
    locationId: string,
  ): Promise<PolicyCandidate[]> {
    const rows = await this.prisma.storeFlowPolicy.findMany({
      where: { tenantId, OR: [{ locationId }, { locationId: null }] },
      select: {
        locationId: true,
        activeVersion: {
          select: {
            id: true,
            autonomyLevel: true,
            autoApplyMinConfidence: true,
            requireInventoryValidation: true,
            settleOnExit: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      locationId: row.locationId,
      version: row.activeVersion,
    }));
  }

  async listPolicies(tenantId: string) {
    return this.prisma.storeFlowPolicy.findMany({
      where: { tenantId },
      orderBy: [{ locationId: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        locationId: true,
        activeVersionId: true,
        createdAt: true,
        updatedAt: true,
        versions: {
          orderBy: { versionNumber: 'desc' },
          select: {
            id: true,
            versionNumber: true,
            autonomyLevel: true,
            autoApplyMinConfidence: true,
            requireInventoryValidation: true,
            settleOnExit: true,
            note: true,
            createdById: true,
            createdAt: true,
          },
        },
      },
    });
  }

  /**
   * Publish a new immutable policy version and point the policy at it.
   *
   * Creating the version and activating it happen in ONE transaction: a
   * version that exists but is not active would be invisible, and a policy
   * pointing at a version that failed to insert would be a dangling
   * reference. The version number is read inside the transaction and the
   * (policyId, versionNumber) unique index rejects the loser of a race, so two
   * concurrent publishes can never mint the same number.
   */
  async publishPolicyVersion(
    tenantId: string,
    input: {
      locationId: string | null;
      autonomyLevel: StoreFlowAutonomyLevel;
      autoApplyMinConfidence: number;
      requireInventoryValidation: boolean;
      settleOnExit: boolean;
      note: string | null;
      createdById: string | null;
    },
    onPublished: (payload: {
      policyId: string;
      versionId: string;
      versionNumber: number;
      previousVersionId: string | null;
    }) => Promise<void>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (input.locationId) {
        // TENANT ISOLATION: resolve the store inside this tenant before it is
        // written, so a known foreign location id cannot anchor a policy.
        const location = await tx.location.findFirst({
          where: { tenantId, id: input.locationId },
          select: { id: true },
        });
        if (!location) {
          return 'location-not-found' as const;
        }
      }
      const existing = await tx.storeFlowPolicy.findFirst({
        where: { tenantId, locationId: input.locationId },
        select: { id: true, activeVersionId: true },
      });
      const policy =
        existing ??
        (await tx.storeFlowPolicy.create({
          data: {
            tenantId,
            locationId: input.locationId,
            createdById: input.createdById,
          },
          select: { id: true, activeVersionId: true },
        }));

      const highest = await tx.storeFlowPolicyVersion.findFirst({
        where: { tenantId, policyId: policy.id },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const versionNumber = (highest?.versionNumber ?? 0) + 1;

      const version = await tx.storeFlowPolicyVersion.create({
        data: {
          tenantId,
          policyId: policy.id,
          versionNumber,
          autonomyLevel: input.autonomyLevel,
          autoApplyMinConfidence: input.autoApplyMinConfidence,
          requireInventoryValidation: input.requireInventoryValidation,
          settleOnExit: input.settleOnExit,
          note: input.note,
          createdById: input.createdById,
        },
      });

      await tx.storeFlowPolicy.update({
        where: { id_tenantId: { id: policy.id, tenantId } },
        data: { activeVersionId: version.id },
      });

      await onPublished({
        policyId: policy.id,
        versionId: version.id,
        versionNumber,
        previousVersionId: policy.activeVersionId,
      });

      return { policyId: policy.id, version };
    });
  }

  // -------------------------------------------------------------------------
  // Shoppers and entry tokens
  // -------------------------------------------------------------------------

  /**
   * Create an anonymous shopper inside the redemption transaction, so a
   * shopper never outlives a failed entry. Tenant is set here, never by the
   * caller.
   */
  async createShopperInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string | null,
  ): Promise<{ id: string }> {
    return tx.shopper.create({
      data: { tenantId, userId, status: ShopperStatus.ACTIVE },
      select: { id: true },
    });
  }

  async findShopper(tenantId: string, id: string) {
    return this.prisma.shopper.findFirst({
      where: { tenantId, id },
      select: { id: true, status: true, userId: true },
    });
  }

  /**
   * Record a newly minted entry credential. Only the digest is stored; the
   * secret exists in memory long enough to be returned once.
   */
  async createEntryToken(
    tenantId: string,
    input: {
      locationId: string;
      unitId: string;
      shopperId: string | null;
      tokenHash: string;
      expiresAt: Date;
      issuedById: string | null;
    },
  ) {
    return this.prisma.storeEntryToken.create({
      data: { tenantId, ...input },
      select: ENTRY_TOKEN_PUBLIC_SELECT,
    });
  }

  /** Resolve a store and unit inside this tenant, refusing a mismatch. */
  async resolveUnit(tenantId: string, locationId: string, unitId: string) {
    return this.prisma.retailUnit.findFirst({
      where: { tenantId, id: unitId, locationId },
      select: { id: true, locationId: true },
    });
  }

  /**
   * Look a credential up by its digest. Lookup is by digest, never by id, so
   * an attacker holding an id cannot enumerate tokens.
   */
  async findEntryTokenByHash(
    tenantId: string,
    tokenHash: string,
  ): Promise<EntryTokenRow | null> {
    return this.prisma.storeEntryToken.findFirst({
      where: { tenantId, tokenHash },
      select: { ...ENTRY_TOKEN_PUBLIC_SELECT, tokenHash: true },
    });
  }

  async findEntryToken(tenantId: string, id: string) {
    return this.prisma.storeEntryToken.findFirst({
      where: { tenantId, id },
      select: ENTRY_TOKEN_PUBLIC_SELECT,
    });
  }

  async listEntryTokens(tenantId: string, limit: number) {
    return this.prisma.storeEntryToken.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: ENTRY_TOKEN_PUBLIC_SELECT,
    });
  }

  /**
   * Burn a credential and bind it to the journey it opened.
   *
   * The update is guarded on `status: ISSUED`, so two concurrent redemptions
   * of the same token race on the database rather than in application code:
   * exactly one updates a row, and the loser sees zero rows affected and is
   * rejected as already used.
   */
  async redeemEntryToken(
    tx: Prisma.TransactionClient,
    tenantId: string,
    tokenId: string,
    journeyId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tx.storeEntryToken.updateMany({
      where: { tenantId, id: tokenId, status: StoreEntryTokenStatus.ISSUED },
      data: {
        status: StoreEntryTokenStatus.REDEEMED,
        redeemedAt: now,
        redeemedJourneyId: journeyId,
      },
    });
    return result.count === 1;
  }

  async revokeEntryToken(tenantId: string, tokenId: string, now: Date) {
    const result = await this.prisma.storeEntryToken.updateMany({
      where: { tenantId, id: tokenId, status: StoreEntryTokenStatus.ISSUED },
      data: { status: StoreEntryTokenStatus.REVOKED, revokedAt: now },
    });
    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // Journeys
  // -------------------------------------------------------------------------

  async findJourney(
    tenantId: string,
    journeyId: string,
  ): Promise<StoreFlowJourneyRow | null> {
    return this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      select: JOURNEY_SELECT,
    });
  }

  async listStoreFlowJourneys(tenantId: string, limit: number) {
    return this.prisma.customerJourney.findMany({
      where: { tenantId, shopperId: { not: null } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: JOURNEY_SELECT,
    });
  }

  /** Bind a freshly opened journey to its shopper and checkout session. */
  async bindJourneyToSession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    journeyId: string,
    shopperId: string,
    checkoutSessionId: string,
  ) {
    await tx.customerJourney.update({
      where: { id_tenantId: { id: journeyId, tenantId } },
      data: { shopperId, checkoutSessionId },
    });
  }

  async setJourneySettlement(
    tenantId: string,
    journeyId: string,
    data: { orderId?: string; settlementStatus: StoreFlowSettlementStatus },
  ) {
    await this.prisma.customerJourney.update({
      where: { id_tenantId: { id: journeyId, tenantId } },
      data,
    });
  }

  // -------------------------------------------------------------------------
  // Observations and projections
  // -------------------------------------------------------------------------

  async observations(
    tenantId: string,
    journeyId: string,
  ): Promise<ObservationRow[]> {
    return this.prisma.customerJourneyEvent.findMany({
      where: { tenantId, journeyId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: OBSERVATION_SELECT,
    });
  }

  async findObservation(
    tenantId: string,
    journeyEventId: string,
  ): Promise<ObservationRow | null> {
    return this.prisma.customerJourneyEvent.findFirst({
      where: { tenantId, id: journeyEventId },
      select: OBSERVATION_SELECT,
    });
  }

  async projectionsFor(
    tenantId: string,
    journeyId: string,
  ): Promise<ProjectionRow[]> {
    return this.prisma.storeFlowProjection.findMany({
      where: { tenantId, journeyId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: PROJECTION_SELECT,
    });
  }

  async findProjectionByEvent(
    tenantId: string,
    journeyEventId: string,
  ): Promise<ProjectionRow | null> {
    return this.prisma.storeFlowProjection.findFirst({
      where: { tenantId, journeyEventId },
      select: PROJECTION_SELECT,
    });
  }

  /**
   * Record what the bridge did with one observation.
   *
   * The (tenantId, journeyEventId) unique index is what makes a replayed sync
   * safe: the second attempt loses the insert and the caller re-reads the
   * original row instead of creating a second basket effect.
   */
  async createProjection(
    tenantId: string,
    input: {
      journeyId: string;
      journeyEventId: string;
      outcome: StoreFlowProjectionOutcome;
      reasonCode: string;
      visionEventId: string | null;
      autonomyLevel: StoreFlowAutonomyLevel;
      confidence: number | null;
    },
  ): Promise<ProjectionRow> {
    return this.prisma.storeFlowProjection.create({
      data: { tenantId, ...input },
      select: PROJECTION_SELECT,
    });
  }

  async updateProjectionOutcome(
    tenantId: string,
    projectionId: string,
    data: { outcome: StoreFlowProjectionOutcome; reasonCode: string },
  ): Promise<ProjectionRow> {
    return this.prisma.storeFlowProjection.update({
      where: { id_tenantId: { id: projectionId, tenantId } },
      data,
      select: PROJECTION_SELECT,
    });
  }

  // -------------------------------------------------------------------------
  // Reads the bridge needs from neighbouring domains (never writes)
  // -------------------------------------------------------------------------

  /** On-hand quantity for inventory validation, or null when unstocked. */
  async onHandQuantity(
    tenantId: string,
    locationId: string,
    productId: string,
  ): Promise<number | null> {
    const level = await this.prisma.inventoryLevel.findFirst({
      where: { tenantId, locationId, productId },
      select: { quantity: true },
    });
    return level?.quantity ?? null;
  }

  async productSku(
    tenantId: string,
    productId: string,
  ): Promise<{ sku: string; name: string } | null> {
    return this.prisma.product.findFirst({
      where: { tenantId, id: productId },
      select: { sku: true, name: true },
    });
  }

  async visionEventStatuses(tenantId: string, ids: readonly string[]) {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.visionEvent.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, status: true, sessionId: true, quantity: true },
    });
  }

  async sessionLines(tenantId: string, sessionId: string) {
    return this.prisma.checkoutSessionLine.findMany({
      where: { tenantId, sessionId, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        productId: true,
        sku: true,
        productName: true,
        quantity: true,
        unitPriceMinor: true,
        lineTotalMinor: true,
        currencyCode: true,
      },
    });
  }

  async orderTotals(tenantId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        subtotalMinor: true,
        totalMinor: true,
        currencyCode: true,
      },
    });
  }

  async existingIntentForOrder(tenantId: string, orderId: string) {
    return this.prisma.paymentIntent.findFirst({
      where: { tenantId, orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, amountMinor: true, currencyCode: true },
    });
  }
}
