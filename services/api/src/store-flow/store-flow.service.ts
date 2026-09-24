import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  CustomerJourneyEventType,
  CustomerJourneyStatus,
  JourneyEventReviewDecision,
  PaymentProvider,
  PaymentStatus,
  StoreFlowAutonomyLevel,
  StoreFlowProjectionOutcome,
  StoreFlowSettlementStatus,
  VisionEventStatus,
  VisionReviewDecision,
} from '@prisma/client';
import {
  AuditActor,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { CheckoutSessionsService } from '../checkout/checkout-sessions.service';
import { JourneyService } from '../journey/journey.service';
import { isTerminalPaymentStatus } from '../payments/payment-state-machine';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { VisionEventsService } from '../vision/vision-events.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  ENTRY_TOKEN_DEFAULT_TTL_SECONDS,
  ENTRY_TOKEN_MAX_TTL_SECONDS,
  ENTRY_TOKEN_MIN_TTL_SECONDS,
  IDEMPOTENCY,
  PROJECTION_REASON,
  SETTLEMENT_BLOCK_REASON,
  SettlementBlockReason,
  STORE_FLOW_QUEUE_MAX_ITEMS,
} from './store-flow.constants';
import {
  IssueEntryTokenDto,
  PublishStoreFlowPolicyDto,
  RedeemEntryTokenDto,
  ReviewObservationDto,
} from './store-flow.dto';
import {
  decideProjection,
  digestsMatch,
  EffectiveStoreFlowPolicy,
  entryTokenUsable,
  hashEntryToken,
  inventoryVerdict,
  mintEntryToken,
  resolvePolicy,
} from './store-flow.logic';
import {
  ObservationRow,
  ProjectionRow,
  StoreFlowRepository,
} from './store-flow.repository';

/**
 * Phase 26 — the store flow.
 *
 * This is the bridge the repository was missing: the modern computer-vision
 * stack produced journey observations that nothing consumed, and the only
 * code that could change a basket was the older vision-event review path.
 * Here the two meet.
 *
 * WHY THIS MODULE EXISTS SEPARATELY. The journey, fusion, camera and clip-lab
 * modules are shadow-only by design, and each carries a grep-level guard test
 * that fails if any file in it writes to a checkout, order, payment,
 * inventory or vision-event model. Those guards are load-bearing and stay
 * exactly as they are. The bridge therefore lives outside them: it READS the
 * journey stream through JourneyService and WRITES commerce through the same
 * public services an operator drives by hand. There is no second
 * implementation of basket, order, ledger or payment rules anywhere here.
 *
 * WHAT KEEPS IT SAFE. Three things, in order:
 *   1. Autonomy is a policy, and its default is SHADOW — which reproduces the
 *      behaviour of every earlier phase exactly. Merging this changes nothing
 *      until an operator opts a tenant or a store in.
 *   2. Computer vision proposes, inventory validates, checkout routes. A
 *      confident score is never sufficient on its own: a proposal that the
 *      store's inventory projection calls implausible goes to a human.
 *   3. Every effect is keyed by a stable identifier, so a replayed request
 *      re-reads what it already did instead of doing it twice. The projection
 *      table's unique index on the observation is the backstop.
 */
@Injectable()
export class StoreFlowService {
  private readonly logger = new Logger(StoreFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: StoreFlowRepository,
    private readonly journeys: JourneyService,
    private readonly checkout: CheckoutSessionsService,
    private readonly vision: VisionEventsService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditLogService,
  ) {}

  // =========================================================================
  // Policy
  // =========================================================================

  async listPolicies(tenantId: string) {
    return this.repository.listPolicies(tenantId);
  }

  /** The policy actually in force at one store, after resolution. */
  async effectivePolicy(
    tenantId: string,
    locationId: string,
  ): Promise<EffectiveStoreFlowPolicy> {
    const candidates = await this.repository.policyCandidates(
      tenantId,
      locationId,
    );
    return resolvePolicy(candidates, locationId);
  }

  /**
   * Change the autonomy policy by publishing a NEW immutable version. The
   * previous version is never edited, so the history of who let the store act
   * unattended, when, and why is complete and reversible by publishing an old
   * version's values forward again.
   */
  async publishPolicy(
    tenantId: string,
    dto: PublishStoreFlowPolicyDto,
    actor: AuditActor,
  ) {
    if (dto.note && containsSensitiveFreeText(dto.note)) {
      throw new BadRequestException(
        'note must not contain credential- or payment-bearing content',
      );
    }
    const result = await this.repository.publishPolicyVersion(
      tenantId,
      {
        locationId: dto.locationId ?? null,
        autonomyLevel: dto.autonomyLevel,
        autoApplyMinConfidence: dto.autoApplyMinConfidence ?? 0.7,
        requireInventoryValidation: dto.requireInventoryValidation ?? true,
        settleOnExit: dto.settleOnExit ?? false,
        note: dto.note ?? null,
        createdById: actor.id,
      },
      async ({ policyId, versionId, versionNumber, previousVersionId }) => {
        await this.audit.record({
          tenantId,
          actorId: actor.id,
          actorEmail: actor.email,
          action: AuditAction.CONFIG_CHANGE,
          entityType: 'StoreFlowPolicyVersion',
          entityId: versionId,
          before: previousVersionId ? { versionId: previousVersionId } : null,
          after: {
            policyId,
            versionNumber,
            autonomyLevel: dto.autonomyLevel,
            autoApplyMinConfidence: dto.autoApplyMinConfidence ?? 0.7,
            requireInventoryValidation: dto.requireInventoryValidation ?? true,
            settleOnExit: dto.settleOnExit ?? false,
            locationId: dto.locationId ?? null,
          },
          reason:
            dto.note ??
            `Store-flow autonomy set to ${dto.autonomyLevel} (version ${versionNumber})`,
        });
      },
    );
    if (result === 'location-not-found') {
      throw new BadRequestException(`Store "${dto.locationId}" not found`);
    }
    return result;
  }

  // =========================================================================
  // Entry
  // =========================================================================

  /**
   * Issue a single-use, short-TTL entry credential. The secret is returned
   * HERE and nowhere else — only its digest is stored, so this response is the
   * one and only time it exists outside the caller's hands.
   */
  async issueEntryToken(
    tenantId: string,
    dto: IssueEntryTokenDto,
    actor: AuditActor,
  ) {
    const unit = await this.repository.resolveUnit(
      tenantId,
      dto.locationId,
      dto.unitId,
    );
    if (!unit) {
      throw new BadRequestException(
        `Unit "${dto.unitId}" not found in store "${dto.locationId}"`,
      );
    }
    if (dto.shopperId) {
      const shopper = await this.repository.findShopper(tenantId, dto.shopperId);
      if (!shopper) {
        throw new BadRequestException(`Shopper "${dto.shopperId}" not found`);
      }
      if (shopper.status !== 'ACTIVE') {
        throw new ConflictException('Shopper is blocked from entering');
      }
    }
    const ttlSeconds = Math.min(
      Math.max(
        dto.ttlSeconds ?? ENTRY_TOKEN_DEFAULT_TTL_SECONDS,
        ENTRY_TOKEN_MIN_TTL_SECONDS,
      ),
      ENTRY_TOKEN_MAX_TTL_SECONDS,
    );
    const { secret, tokenHash } = mintEntryToken();
    const token = await this.repository.createEntryToken(tenantId, {
      locationId: dto.locationId,
      unitId: dto.unitId,
      shopperId: dto.shopperId ?? null,
      tokenHash,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      issuedById: actor.id,
    });
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.CREATE,
      entityType: 'StoreEntryToken',
      entityId: token.id,
      // The digest is as sensitive as the secret and never enters the audit
      // trail; the row's descriptor fields are enough to reconstruct events.
      after: {
        locationId: token.locationId,
        unitId: token.unitId,
        shopperId: token.shopperId,
        expiresAt: token.expiresAt,
      },
      reason: `Store entry credential issued (${ttlSeconds}s)`,
    });
    return { token, secret, expiresAt: token.expiresAt };
  }

  async listEntryTokens(tenantId: string, limit?: number) {
    return this.repository.listEntryTokens(
      tenantId,
      Math.min(limit ?? STORE_FLOW_QUEUE_MAX_ITEMS, STORE_FLOW_QUEUE_MAX_ITEMS),
    );
  }

  async revokeEntryToken(tenantId: string, tokenId: string, actor: AuditActor) {
    const revoked = await this.repository.revokeEntryToken(
      tenantId,
      tokenId,
      new Date(),
    );
    if (!revoked) {
      const existing = await this.repository.findEntryToken(tenantId, tokenId);
      if (!existing) {
        throw new NotFoundException(`Entry token "${tokenId}" not found`);
      }
      throw new ConflictException(
        `Entry token is already ${existing.status.toLowerCase()}`,
      );
    }
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.CANCEL,
      entityType: 'StoreEntryToken',
      entityId: tokenId,
      reason: 'Store entry credential revoked before use',
    });
    return this.repository.findEntryToken(tenantId, tokenId);
  }

  /**
   * Redeem a credential: burn it, open the journey, and open the checkout
   * session the journey's observations will fold into.
   *
   * The session is created FIRST, keyed by the token id, and the journey is
   * opened and bound in one transaction that also burns the token. If the
   * transaction fails, the session is left open and a retry with the same
   * token id replays it rather than opening a second one — so a partial
   * failure costs an idle session, never a duplicate basket.
   */
  async redeemEntryToken(
    tenantId: string,
    dto: RedeemEntryTokenDto,
    actor: AuditActor,
  ) {
    const tokenHash = hashEntryToken(dto.token);
    const token = await this.repository.findEntryTokenByHash(
      tenantId,
      tokenHash,
    );
    // A wrong token and an unknown token are the same answer on purpose:
    // redemption must not tell a caller whether a credential exists.
    if (!token || !digestsMatch(token.tokenHash, tokenHash)) {
      throw new NotFoundException('Entry credential is not valid');
    }
    const usable = entryTokenUsable(token, new Date());
    if (!usable.usable) {
      throw new ConflictException(
        `Entry credential is not usable (${usable.reason})`,
      );
    }

    const session = await this.checkout.create(
      tenantId,
      {
        locationId: token.locationId,
        unitId: token.unitId,
        idempotencyKey: IDEMPOTENCY.entrySession(token.id),
      },
      actor,
    );

    const { journeyId, shopperId } = await this.prisma.$transaction(
      async (tx) => {
        const shopper =
          token.shopperId ??
          (
            await this.repository.createShopperInTransaction(
              tx,
              tenantId,
              null,
            )
          ).id;
        const opened = await this.journeys.openJourneyInTransaction(
          tx,
          tenantId,
          { locationId: token.locationId, unitId: token.unitId },
          actor.id,
        );
        await this.repository.bindJourneyToSession(
          tx,
          tenantId,
          opened.journeyId,
          shopper,
          session.id,
        );
        const burned = await this.repository.redeemEntryToken(
          tx,
          tenantId,
          token.id,
          opened.journeyId,
          new Date(),
        );
        if (!burned) {
          // Another redemption won the race between our read and this write.
          // Rolling back leaves the loser with nothing, which is the point of
          // a single-use credential.
          throw new ConflictException(
            'Entry credential is not usable (ALREADY_USED)',
          );
        }
        return { journeyId: opened.journeyId, shopperId: shopper };
      },
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.REGISTER,
      entityType: 'CustomerJourney',
      entityId: journeyId,
      after: { shopperId, checkoutSessionId: session.id, tokenId: token.id },
      reason: 'Shopper entered the store and a journey and basket were opened',
    });

    return {
      journeyId,
      shopperId,
      checkoutSessionId: session.id,
      locationId: token.locationId,
      unitId: token.unitId,
    };
  }

  // =========================================================================
  // The bridge
  // =========================================================================

  /**
   * Project every observation on a journey that has not been projected yet.
   *
   * This is a catch-up operation on purpose: observations reach the journey
   * from several places (clip lab, camera replay, live sessions, manual
   * appends) and the bridge must not care which. Running it twice is a no-op.
   */
  async syncJourney(tenantId: string, journeyId: string, actor: AuditActor) {
    const journey = await this.repository.findJourney(tenantId, journeyId);
    if (!journey) {
      throw new NotFoundException(`Journey "${journeyId}" not found`);
    }
    const policy = await this.effectivePolicy(tenantId, journey.locationId);

    // SHADOW is inert by construction: no projection rows, no vision events,
    // no basket effects. Identical to the behaviour before this phase.
    if (policy.autonomyLevel === StoreFlowAutonomyLevel.SHADOW) {
      return {
        journeyId,
        autonomyLevel: policy.autonomyLevel,
        projected: [] as ProjectionRow[],
        skippedShadow: true,
      };
    }
    if (!journey.checkoutSessionId) {
      throw new ConflictException(
        'journey has no checkout session — only journeys opened through a ' +
          'store entry credential can be projected onto a basket ' +
          '(STORE_FLOW_JOURNEY_NOT_BOUND)',
      );
    }

    const observations = await this.repository.observations(tenantId, journeyId);
    const existing = await this.repository.projectionsFor(tenantId, journeyId);
    const already = new Set(existing.map((row) => row.journeyEventId));

    const projected: ProjectionRow[] = [];
    for (const observation of observations) {
      if (already.has(observation.id)) {
        continue;
      }
      const row = await this.projectObservation(
        tenantId,
        journey.locationId,
        journey.unitId,
        journey.checkoutSessionId,
        observation,
        policy,
        actor,
      );
      if (row) {
        projected.push(row);
      }
    }
    return {
      journeyId,
      autonomyLevel: policy.autonomyLevel,
      projected,
      skippedShadow: false,
    };
  }

  /**
   * Decide and record what happens to ONE observation.
   *
   * The decision is pure (store-flow.logic.ts); this method only performs the
   * writes it asks for, in an order that leaves no state the projection row
   * cannot explain.
   */
  private async projectObservation(
    tenantId: string,
    locationId: string,
    unitId: string | null,
    checkoutSessionId: string,
    observation: ObservationRow,
    policy: EffectiveStoreFlowPolicy,
    actor: AuditActor,
  ): Promise<ProjectionRow | null> {
    // Inventory validates before checkout routes. The read is cheap and only
    // needed for movements that could be applied unattended.
    let verdict: ReturnType<typeof inventoryVerdict> = 'NOT_CHECKED';
    if (
      observation.productId &&
      policy.autonomyLevel === StoreFlowAutonomyLevel.AUTO_APPLY
    ) {
      const onHand = await this.repository.onHandQuantity(
        tenantId,
        locationId,
        observation.productId,
      );
      verdict = inventoryVerdict(
        observation.eventType,
        onHand,
        observation.quantity,
      );
    }

    const decision = decideProjection(
      {
        eventType: observation.eventType,
        productId: observation.productId,
        quantity: observation.quantity,
        matchScore: observation.matchScore,
      },
      policy,
      verdict,
    );

    let visionEventId: string | null = null;
    if (decision.createsVisionEvent && decision.visionEventType) {
      const unitForEvent = unitId;
      if (!unitForEvent) {
        // A vision event requires a unit; a journey opened without one cannot
        // produce basket effects. Record it as a review item rather than
        // failing the whole sync.
        return this.recordProjection(tenantId, observation, {
          outcome: StoreFlowProjectionOutcome.REVIEW_REQUIRED,
          reasonCode: PROJECTION_REASON.UNKNOWN_PRODUCT,
          visionEventId: null,
          autonomyLevel: policy.autonomyLevel,
          confidence: observation.matchScore,
        });
      }
      const product = observation.productId
        ? await this.repository.productSku(tenantId, observation.productId)
        : null;
      if (!product) {
        return this.recordProjection(tenantId, observation, {
          outcome: StoreFlowProjectionOutcome.REVIEW_REQUIRED,
          reasonCode: PROJECTION_REASON.UNKNOWN_PRODUCT,
          visionEventId: null,
          autonomyLevel: policy.autonomyLevel,
          confidence: observation.matchScore,
        });
      }
      const event = await this.vision.ingest(
        tenantId,
        {
          locationId,
          unitId: unitForEvent,
          sessionId: checkoutSessionId,
          type: decision.visionEventType,
          occurredAt: observation.occurredAt.toISOString(),
          quantity: observation.quantity,
          candidates: [
            {
              sku: product.sku,
              rank: 1,
              score: observation.matchScore ?? undefined,
            },
          ],
          idempotencyKey: IDEMPOTENCY.visionEvent(observation.id),
        },
        actor,
      );
      visionEventId = event.id;

      if (decision.autoApproves) {
        // Routed through the SAME review path a human uses, so the basket
        // effect, its audit trail and its guarantees are identical.
        await this.vision.review(
          tenantId,
          event.id,
          {
            decision: VisionReviewDecision.APPROVE,
            reason: 'Applied automatically by the store-flow autonomy policy',
          },
          actor,
        );
      }
    }

    return this.recordProjection(tenantId, observation, {
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      visionEventId,
      autonomyLevel: policy.autonomyLevel,
      confidence: observation.matchScore,
    });
  }

  /**
   * Write the projection row, tolerating the race where a concurrent sync
   * already wrote it: the unique index on (tenant, observation) is the real
   * guarantee, and losing that race means the work was already done.
   */
  private async recordProjection(
    tenantId: string,
    observation: ObservationRow,
    input: {
      outcome: StoreFlowProjectionOutcome;
      reasonCode: string;
      visionEventId: string | null;
      autonomyLevel: StoreFlowAutonomyLevel;
      confidence: number | null;
    },
  ): Promise<ProjectionRow | null> {
    try {
      return await this.repository.createProjection(tenantId, {
        journeyId: observation.journeyId,
        journeyEventId: observation.id,
        ...input,
      });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null
          ? String((error as { code?: unknown }).code ?? '')
          : '';
      if (code === 'P2002') {
        this.logger.debug(
          `observation ${observation.id} was projected concurrently`,
        );
        return this.repository.findProjectionByEvent(tenantId, observation.id);
      }
      throw error;
    }
  }

  // =========================================================================
  // One review queue
  // =========================================================================

  /**
   * The queue an operator actually works. The journey queue and the
   * vision-event queue used to be separate lists with separate decisions, and
   * approving in the journey one had no commerce effect. This joins them: one
   * row per uncertain observation, carrying both the observation and what the
   * bridge did with it.
   */
  async reviewQueue(tenantId: string) {
    const items = await this.journeys.reviewQueue(tenantId);
    const projections = await Promise.all(
      items.map((item) =>
        this.repository.findProjectionByEvent(tenantId, item.eventId),
      ),
    );
    const visionEventIds = projections
      .map((projection) => projection?.visionEventId)
      .filter((id): id is string => typeof id === 'string');
    const visionEvents = await this.repository.visionEventStatuses(
      tenantId,
      visionEventIds,
    );
    const byId = new Map(visionEvents.map((event) => [event.id, event]));

    return items.map((item, index) => {
      const projection = projections[index];
      const visionEvent = projection?.visionEventId
        ? byId.get(projection.visionEventId)
        : undefined;
      return {
        ...item,
        storeFlow: projection
          ? {
              projectionId: projection.id,
              outcome: projection.outcome,
              reasonCode: projection.reasonCode,
              autonomyLevel: projection.autonomyLevel,
              visionEventId: projection.visionEventId,
              visionEventStatus: visionEvent?.status ?? null,
              checkoutSessionId: visionEvent?.sessionId ?? null,
            }
          : null,
      };
    });
  }

  /**
   * Record ONE operator decision in both places it has to land: the
   * append-only journey review stream, and the vision event whose approval is
   * what actually moves the basket.
   *
   * The journey review is recorded first. If the vision-event side then
   * fails, the human's decision is still on the record and re-running this
   * with the same idempotency key completes the commerce half — the journey
   * stream stays append-only and never gains a second copy of the decision.
   */
  async reviewObservation(
    tenantId: string,
    journeyEventId: string,
    dto: ReviewObservationDto,
    actor: AuditActor,
  ) {
    const observation = await this.repository.findObservation(
      tenantId,
      journeyEventId,
    );
    if (!observation) {
      throw new NotFoundException(`Observation "${journeyEventId}" not found`);
    }

    const corrected =
      dto.decision === JourneyEventReviewDecision.CORRECT
        ? {
            correctedEventType:
              observation.eventType === CustomerJourneyEventType.PRODUCT_RETURN
                ? CustomerJourneyEventType.PRODUCT_RETURN
                : CustomerJourneyEventType.PRODUCT_PICKUP,
            correctedProductId: dto.correctedProductId ?? null,
            correctedQuantity: dto.correctedQuantity ?? null,
          }
        : {};

    const journeyReview = await this.journeys.reviewEvent(
      tenantId,
      observation.journeyId,
      journeyEventId,
      {
        decision: dto.decision,
        reason: dto.reason ?? null,
        idempotencyKey: dto.idempotencyKey ?? null,
        ...corrected,
      },
      actor,
    );

    const projection = await this.repository.findProjectionByEvent(
      tenantId,
      journeyEventId,
    );
    if (!projection?.visionEventId) {
      // Nothing was ever proposed for this observation (SHADOW, or the
      // pipeline flagged it before a vision event existed). The human's
      // decision is recorded; there is no basket to move.
      return { journeyReview, visionEvent: null, projection };
    }

    const [visionEvent] = await this.repository.visionEventStatuses(tenantId, [
      projection.visionEventId,
    ]);
    if (visionEvent && visionEvent.status !== VisionEventStatus.PENDING_REVIEW) {
      // Already decided — a replay, or an operator who used the vision route
      // directly. Do not decide it twice.
      return { journeyReview, visionEvent, projection };
    }

    const decision =
      dto.decision === JourneyEventReviewDecision.APPROVE
        ? VisionReviewDecision.APPROVE
        : dto.decision === JourneyEventReviewDecision.REJECT
          ? VisionReviewDecision.REJECT
          : VisionReviewDecision.OVERRIDE;

    const reviewed = await this.vision.review(
      tenantId,
      projection.visionEventId,
      {
        decision,
        reason: dto.reason,
        ...(decision === VisionReviewDecision.OVERRIDE
          ? {
              productId: dto.correctedProductId,
              quantity: dto.correctedQuantity,
            }
          : {}),
      },
      actor,
    );

    const outcome =
      dto.decision === JourneyEventReviewDecision.REJECT
        ? StoreFlowProjectionOutcome.REJECTED
        : StoreFlowProjectionOutcome.AUTO_APPLIED;
    const reasonCode =
      dto.decision === JourneyEventReviewDecision.REJECT
        ? PROJECTION_REASON.REJECTED_BY_REVIEWER
        : dto.decision === JourneyEventReviewDecision.CORRECT
          ? PROJECTION_REASON.CORRECTED_BY_REVIEWER
          : PROJECTION_REASON.APPROVED_BY_REVIEWER;
    const updated = await this.repository.updateProjectionOutcome(
      tenantId,
      projection.id,
      { outcome, reasonCode },
    );

    return { journeyReview, visionEvent: reviewed, projection: updated };
  }

  // =========================================================================
  // Exit and settlement
  // =========================================================================

  /**
   * Close the journey and, when the policy allows it, turn the basket into an
   * order and settle it.
   *
   * Ordering matters and is deliberate:
   *   1. catch up on any unprojected observation, so nothing the shopper did
   *      is missing from the basket;
   *   2. refuse to settle while any proposal still waits for a human — an
   *      unreviewed pickup must never be silently billed or silently dropped;
   *   3. close the journey;
   *   4. complete the session (which writes the SALE ledger movements and
   *      creates the order) keyed by the journey id;
   *   5. open, authorise and capture a payment intent for the order total.
   *
   * Every step is keyed off the journey or the order, so replaying an exit
   * re-reads what it already did. Step 4 in particular is what protects the
   * ledger: the completion idempotency key is derived from the journey, so a
   * duplicate exit cannot consume stock twice.
   */
  async exitJourney(tenantId: string, journeyId: string, actor: AuditActor) {
    const journey = await this.repository.findJourney(tenantId, journeyId);
    if (!journey) {
      throw new NotFoundException(`Journey "${journeyId}" not found`);
    }
    const policy = await this.effectivePolicy(tenantId, journey.locationId);

    if (policy.autonomyLevel === StoreFlowAutonomyLevel.SHADOW) {
      // Pre-Phase-26 behaviour, unchanged: close the journey, settle nothing.
      const closed =
        journey.status === CustomerJourneyStatus.OPEN
          ? await this.journeys.exit(tenantId, journeyId, actor.id)
          : await this.journeys.detail(tenantId, journeyId);
      return {
        journey: closed,
        settlement: {
          status: StoreFlowSettlementStatus.NOT_STARTED,
          blockedBy: SETTLEMENT_BLOCK_REASON.SETTLEMENT_DISABLED,
          order: null,
          payment: null,
        },
      };
    }

    if (journey.status === CustomerJourneyStatus.OPEN) {
      await this.syncJourney(tenantId, journeyId, actor);
    }

    const blocked = await this.pendingReviewBlock(tenantId, journeyId);
    if (journey.status === CustomerJourneyStatus.OPEN) {
      await this.journeys.exit(tenantId, journeyId, actor.id);
    }

    if (blocked) {
      await this.repository.setJourneySettlement(tenantId, journeyId, {
        settlementStatus: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
      });
      return {
        journey: await this.journeys.detail(tenantId, journeyId),
        settlement: {
          status: StoreFlowSettlementStatus.BLOCKED_ON_REVIEW,
          blockedBy: SETTLEMENT_BLOCK_REASON.AWAITING_EVENT_REVIEW,
          order: null,
          payment: null,
        },
      };
    }

    let settlement: Awaited<ReturnType<StoreFlowService['settle']>>;
    try {
      settlement = await this.settle(tenantId, journeyId, policy, actor);
    } catch (error) {
      // The journey is already closed at this point, so a failed settlement
      // must leave a mark the operator can find: an exited journey sitting at
      // NOT_STARTED is indistinguishable from one the policy never settles.
      // The error still propagates — recording it is not handling it.
      await this.repository.setJourneySettlement(tenantId, journeyId, {
        settlementStatus: StoreFlowSettlementStatus.FAILED,
      });
      this.logger.error(
        `journey ${journeyId} failed to settle at exit: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
    return {
      journey: await this.journeys.detail(tenantId, journeyId),
      settlement,
    };
  }

  /** Is any proposal on this journey still waiting for a person? */
  private async pendingReviewBlock(
    tenantId: string,
    journeyId: string,
  ): Promise<boolean> {
    const projections = await this.repository.projectionsFor(
      tenantId,
      journeyId,
    );
    if (
      projections.some(
        (row) => row.outcome === StoreFlowProjectionOutcome.REVIEW_REQUIRED,
      )
    ) {
      return true;
    }
    const ids = projections
      .map((row) => row.visionEventId)
      .filter((id): id is string => typeof id === 'string');
    const events = await this.repository.visionEventStatuses(tenantId, ids);
    return events.some(
      (event) => event.status === VisionEventStatus.PENDING_REVIEW,
    );
  }

  /**
   * Complete the basket into an order and take the money, both idempotently.
   */
  private async settle(
    tenantId: string,
    journeyId: string,
    policy: EffectiveStoreFlowPolicy,
    actor: AuditActor,
  ): Promise<{
    status: StoreFlowSettlementStatus;
    blockedBy: SettlementBlockReason | null;
    order: { id: string; orderNumber: string } | null;
    payment: { id: string; status: PaymentStatus } | null;
  }> {
    const journey = await this.repository.findJourney(tenantId, journeyId);
    if (!journey?.checkoutSessionId) {
      throw new ConflictException(
        'journey has no checkout session to settle (STORE_FLOW_JOURNEY_NOT_BOUND)',
      );
    }
    if (!policy.settleOnExit) {
      return {
        status: StoreFlowSettlementStatus.NOT_STARTED,
        blockedBy: SETTLEMENT_BLOCK_REASON.SETTLEMENT_DISABLED,
        order: null,
        payment: null,
      };
    }

    const lines = await this.repository.sessionLines(
      tenantId,
      journey.checkoutSessionId,
    );
    if (lines.length === 0) {
      // A shopper who took nothing leaves without an order. Recording it as
      // NOT_STARTED with a reason keeps the empty case legible.
      return {
        status: StoreFlowSettlementStatus.NOT_STARTED,
        blockedBy: SETTLEMENT_BLOCK_REASON.EMPTY_BASKET,
        order: null,
        payment: null,
      };
    }

    const completed = await this.checkout.complete(
      tenantId,
      journey.checkoutSessionId,
      { idempotencyKey: IDEMPOTENCY.exitOrder(journeyId) },
      actor,
    );
    const orderId = completed.id;
    await this.repository.setJourneySettlement(tenantId, journeyId, {
      orderId,
      settlementStatus: StoreFlowSettlementStatus.ORDER_CREATED,
    });
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.COMPLETE,
      entityType: 'CustomerJourney',
      entityId: journeyId,
      after: { orderId, orderNumber: completed.orderNumber },
      reason: 'Shopper exit completed the basket into an order',
    });

    const totals = await this.repository.orderTotals(tenantId, orderId);
    if (!totals?.totalMinor || !totals.currencyCode) {
      // Pricing could not value this basket (no active price book, or a
      // product with no price). The order stands and is payable by hand.
      return {
        status: StoreFlowSettlementStatus.ORDER_CREATED,
        blockedBy: SETTLEMENT_BLOCK_REASON.NO_ORDER_TOTAL,
        order: { id: orderId, orderNumber: completed.orderNumber },
        payment: null,
      };
    }

    const payment = await this.takePayment(
      tenantId,
      orderId,
      totals.totalMinor,
      totals.currencyCode,
      actor,
    );
    if (payment === null) {
      // Phase 26 left this thread for Phase 27, which owns terminal payment
      // states: the order's existing intent is terminal and never captured,
      // so there is nothing to drive and nothing to refund. The order stands,
      // unpaid and payable by hand, with the reason stated.
      return {
        status: StoreFlowSettlementStatus.ORDER_CREATED,
        blockedBy: SETTLEMENT_BLOCK_REASON.PAYMENT_TERMINAL,
        order: { id: orderId, orderNumber: completed.orderNumber },
        payment: null,
      };
    }
    if (payment.status === PaymentStatus.CAPTURED) {
      await this.repository.setJourneySettlement(tenantId, journeyId, {
        orderId,
        settlementStatus: StoreFlowSettlementStatus.PAID,
      });
    }
    return {
      status:
        payment.status === PaymentStatus.CAPTURED
          ? StoreFlowSettlementStatus.PAID
          : StoreFlowSettlementStatus.ORDER_CREATED,
      blockedBy: null,
      order: { id: orderId, orderNumber: completed.orderNumber },
      payment: { id: payment.id, status: payment.status },
    };
  }

  /**
   * Drive the existing provider-neutral payment state machine.
   *
   * No card data is touched anywhere in this path: the intent carries an
   * amount, a currency and a provider, and `SIMULATED` is the only provider
   * this repository has. A real gateway arrives as an adapter behind the same
   * contract, not as a change here.
   *
   * Returns null when the order's existing intent is TERMINAL and was never
   * captured. Phase 26 knew about this case and deliberately left it to the
   * phase that owns terminal payment states; the resolution is to REFUSE to
   * act rather than to throw or to improvise:
   *
   *   * re-authorising is illegal — nothing about a terminal intent may ever
   *     change again, and `payments.authorize` would (correctly) throw;
   *   * minting a SECOND intent under a fresh key would take money for an
   *     attempt somebody deliberately cancelled or that the provider
   *     declined. Retrying payment is a decision, not a side effect of
   *     walking out of a shop.
   *
   * So the exit reports PAYMENT_TERMINAL and leaves the order created and
   * payable by hand. Nothing here is CAPTURED, so the returns module also has
   * nothing to refund — the two halves of the terminal-state story agree.
   */
  private async takePayment(
    tenantId: string,
    orderId: string,
    amountMinor: number,
    currencyCode: string,
    actor: AuditActor,
  ): Promise<{ id: string; status: PaymentStatus } | null> {
    const existing = await this.repository.existingIntentForOrder(
      tenantId,
      orderId,
    );
    if (existing?.status === PaymentStatus.CAPTURED) {
      return { id: existing.id, status: existing.status };
    }
    if (existing && isTerminalPaymentStatus(existing.status)) {
      return null;
    }
    const intent =
      existing ??
      (await this.payments.create(
        tenantId,
        {
          orderId,
          provider: PaymentProvider.SIMULATED,
          amountMinor,
          currencyCode,
          idempotencyKey: IDEMPOTENCY.paymentIntent(orderId),
        },
        actor,
      ));

    // Authorise then capture. Both are idempotent on their own key, so an
    // intent already past either step returns its current state instead of
    // being driven through the transition a second time.
    await this.payments.authorize(
      tenantId,
      intent.id,
      { idempotencyKey: IDEMPOTENCY.paymentAuthorize(orderId) },
      actor,
    );
    const captured = await this.payments.capture(
      tenantId,
      intent.id,
      { idempotencyKey: IDEMPOTENCY.paymentCapture(orderId) },
      actor,
    );
    return { id: intent.id, status: captured.status };
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async listJourneys(tenantId: string, limit?: number) {
    const journeys = await this.repository.listStoreFlowJourneys(
      tenantId,
      Math.min(limit ?? STORE_FLOW_QUEUE_MAX_ITEMS, STORE_FLOW_QUEUE_MAX_ITEMS),
    );
    return Promise.all(
      journeys.map(async (journey) => ({
        ...journey,
        lines: journey.checkoutSessionId
          ? await this.repository.sessionLines(
              tenantId,
              journey.checkoutSessionId,
            )
          : [],
      })),
    );
  }

  async journeyDetail(tenantId: string, journeyId: string) {
    const journey = await this.repository.findJourney(tenantId, journeyId);
    if (!journey) {
      throw new NotFoundException(`Journey "${journeyId}" not found`);
    }
    const [detail, projections, policy] = await Promise.all([
      this.journeys.detail(tenantId, journeyId),
      this.repository.projectionsFor(tenantId, journeyId),
      this.effectivePolicy(tenantId, journey.locationId),
    ]);
    const lines = journey.checkoutSessionId
      ? await this.repository.sessionLines(tenantId, journey.checkoutSessionId)
      : [];
    return {
      journey: { ...detail, ...journey },
      policy,
      projections,
      basket: lines,
    };
  }
}
