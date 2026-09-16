import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuditActor } from '../common/audit/audit-log.service';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { hashEntryToken } from '../store-flow/store-flow.logic';
import { StoreFlowService } from '../store-flow/store-flow.service';
import { EnterStoreDto } from './shopper.dto';
import {
  ENTRY_CREDENTIAL_INVALID,
  SHOPPER_SESSION_INVALID,
  STORE_FLOW_MODULE_CODE,
} from './shopper.constants';
import {
  detectionView,
  parseShopperCredential,
  settlementViewFromJourney,
  ShopperView,
  shopperSessionUsable,
  summariseBasket,
} from './shopper.logic';
import { ShopperRepository } from './shopper.repository';

/**
 * A resolved shopper principal: one journey, in one tenant, and the operator
 * accountable for the credential that opened it.
 */
interface ShopperSession {
  tenantId: string;
  journeyId: string;
  actor: AuditActor;
}

/**
 * Phase 35 — the shopper-facing surface over the Phase 26 store loop.
 *
 * WHY THIS EXISTS. Every store-flow route is a STAFF route: tenant-scoped,
 * RBAC-gated, module-gated. A shopper has none of those things and must
 * never be handed any of them — an access token that can read
 * `/store-flow/journeys` can read every shopper in the tenant. So the
 * shopper gets a principal of its own.
 *
 * WHAT THE PRINCIPAL IS. The entry credential Phase 26 already issues: 32
 * bytes of entropy, handed out exactly once, stored only as a SHA-256
 * digest. Redeeming it burns it and binds it to one journey
 * (`redeemedJourneyId`, UNIQUE — one credential can only ever open one
 * journey). After that, the same secret is what proves "I am the shopper on
 * that journey", for a bounded window. It names no tenant, no store, no
 * user, and no other journey, because it CANNOT: every id this module uses
 * is read off the credential row server-side.
 *
 * WHAT KEEPS IT AS STRONG AS ITS NEIGHBOURS. The staff guards cannot run on
 * an anonymous route, so their checks are performed here instead, in the
 * same order and to the same standard — following the precedent this
 * repository already set for a non-user principal in
 * `devices/edge-registration.service.ts`:
 *
 *   * TENANT SCOPING — resolved from the credential row, never from input.
 *     Identical to what AuthGuard does for a staff user.
 *   * TENANT STATUS — a suspended or archived tenant is refused, exactly as
 *     login and AuthGuard refuse one.
 *   * MODULE GATING — `store-flow` must be ENABLED for that tenant, the same
 *     condition `@RequireModule('store-flow')` enforces on every neighbour.
 *   * AUTHORIZATION — in place of RBAC, the credential authorizes exactly
 *     ONE journey and exactly three operations on it: see your own basket,
 *     leave, and read the outcome. There is no shopper route that lists
 *     journeys, reads a policy, sees the review queue, issues a credential,
 *     or decides anything.
 *   * ACCOUNTABILITY — the audit trail wants a real actor, and FK columns
 *     like `CheckoutSession.createdById` want a real user. Actions are
 *     therefore attributed to the OPERATOR WHO ISSUED the credential, who is
 *     a real, active user of that tenant and is the accountable party for a
 *     credential they handed out. A credential whose issuer is gone opens
 *     nothing.
 *
 * WHAT IT DOES NOT DO. No commerce logic. Every effect is a call into
 * `StoreFlowService` — the same method, with the same idempotency keys, the
 * same review gate and the same payment abstraction an operator drives from
 * the admin surface. There is no second settlement path.
 */
@Injectable()
export class ShopperService {
  constructor(
    private readonly repository: ShopperRepository,
    private readonly platformModules: PlatformModulesService,
    private readonly storeFlow: StoreFlowService,
  ) {}

  // =========================================================================
  // Entry
  // =========================================================================

  /**
   * Redeem an entry credential and open the visit.
   *
   * The failure vocabulary is Phase 26's, unchanged and deliberately so:
   * an expired credential and an already-redeemed one are distinguishable
   * (a shopper at a door has to be told to fetch a new code), while an
   * unknown credential and a wrong one are the same answer. This route adds
   * no new way to tell those two apart — everything it checks BEFORE
   * delegating answers with the very message Phase 26 gives an unknown
   * secret.
   */
  async enter(dto: EnterStoreDto): Promise<ShopperView> {
    const credential = await this.repository.findCredentialByHash(
      hashEntryToken(dto.token),
    );
    if (!credential) {
      throw new NotFoundException(ENTRY_CREDENTIAL_INVALID);
    }
    const actor = await this.resolveTenantAndActor(
      credential.tenantId,
      credential.issuedById,
    );
    if (!actor) {
      throw new NotFoundException(ENTRY_CREDENTIAL_INVALID);
    }

    // Phase 26 owns redemption entirely: the digest match, the constant-time
    // compare, the usability check, the guarded updateMany that makes
    // concurrent redemptions race at the database, the checkout session, the
    // journey and the audit entry. Its exceptions propagate untouched.
    const redeemed = await this.storeFlow.redeemEntryToken(
      credential.tenantId,
      { token: dto.token },
      actor,
    );
    return this.view(
      { tenantId: credential.tenantId, journeyId: redeemed.journeyId, actor },
      null,
    );
  }

  // =========================================================================
  // The visit
  // =========================================================================

  /** The shopper's own basket, as it stands. */
  async basket(authorization: string | undefined): Promise<ShopperView> {
    const session = await this.authenticate(authorization);
    return this.view(session, null);
  }

  /**
   * The shopper leaves.
   *
   * Straight through to Phase 26's exit, which catches up on observations,
   * REFUSES to settle while anything waits for a human, closes the journey,
   * completes the basket into an order and drives the simulated payment
   * state machine. Replay-safe there, so replay-safe here: a shopper who
   * taps twice, or who reloads on a flaky connection, re-reads the outcome
   * instead of paying twice.
   */
  async exit(authorization: string | undefined): Promise<ShopperView> {
    const session = await this.authenticate(authorization);
    const result = await this.storeFlow.exitJourney(
      session.tenantId,
      session.journeyId,
      session.actor,
    );
    return this.view(session, result.settlement.blockedBy);
  }

  // =========================================================================
  // Principal resolution
  // =========================================================================

  /**
   * Turn an `Authorization: Shopper <secret>` header into a journey-scoped
   * principal, or refuse with one generic message.
   *
   * There is exactly one failure message for every branch below, so this
   * route cannot be used to learn whether a secret exists, which tenant it
   * belongs to, whether that tenant is active, whether the module is on,
   * whether the credential was redeemed, or when it expired.
   */
  private async authenticate(
    authorization: string | undefined,
  ): Promise<ShopperSession> {
    const secret = parseShopperCredential(authorization);
    if (!secret) {
      throw new UnauthorizedException(SHOPPER_SESSION_INVALID);
    }
    const credential = await this.repository.findCredentialByHash(
      hashEntryToken(secret),
    );
    if (!credential) {
      throw new UnauthorizedException(SHOPPER_SESSION_INVALID);
    }
    const usable = shopperSessionUsable(credential, new Date());
    if (!usable.usable || !credential.redeemedJourneyId) {
      throw new UnauthorizedException(SHOPPER_SESSION_INVALID);
    }
    const actor = await this.resolveTenantAndActor(
      credential.tenantId,
      credential.issuedById,
    );
    if (!actor) {
      throw new UnauthorizedException(SHOPPER_SESSION_INVALID);
    }
    return {
      tenantId: credential.tenantId,
      journeyId: credential.redeemedJourneyId,
      actor,
    };
  }

  /**
   * The three tenant-level checks a staff request gets from its guards, run
   * here because an anonymous request has no guards to run them: the tenant
   * is ACTIVE, the `store-flow` module is ENABLED for it, and the issuing
   * operator is still an active user of it. Any miss returns null, and every
   * caller turns null into its own generic refusal.
   */
  private async resolveTenantAndActor(
    tenantId: string,
    issuedById: string | null,
  ): Promise<AuditActor | null> {
    if (!issuedById) {
      return null;
    }
    if (!(await this.repository.tenantIsActive(tenantId))) {
      return null;
    }
    const enabled = await this.platformModules.isEnabledForTenant(
      tenantId,
      STORE_FLOW_MODULE_CODE,
    );
    if (!enabled) {
      return null;
    }
    const issuer = await this.repository.findActiveIssuer(tenantId, issuedById);
    return issuer ? { id: issuer.id, email: issuer.email } : null;
  }

  // =========================================================================
  // The view
  // =========================================================================

  /**
   * Build the ONLY projection a shopper ever receives.
   *
   * It is an allowlist, not a redaction: the fields below are assembled one
   * by one from narrow reads, so nothing a future Phase 26 field adds can
   * arrive here by accident. Absent by construction: the tenant id, the
   * store and unit ids, the shopper id, the checkout session id, the order
   * id, catalog product ids, the autonomy policy's thresholds, every
   * projection row, every confidence score, and anything at all about any
   * other journey.
   */
  private async view(
    session: ShopperSession,
    blockedBy: string | null,
  ): Promise<ShopperView> {
    const journey = await this.repository.findJourney(
      session.tenantId,
      session.journeyId,
    );
    if (!journey) {
      // The credential named a journey that is not in its own tenant, or is
      // gone. Neither is a thing a shopper can act on.
      throw new UnauthorizedException(SHOPPER_SESSION_INVALID);
    }
    const [policy, lines, order] = await Promise.all([
      this.storeFlow.effectivePolicy(session.tenantId, journey.locationId),
      journey.checkoutSessionId
        ? this.repository.basketLines(
            session.tenantId,
            journey.checkoutSessionId,
          )
        : Promise.resolve([]),
      journey.orderId
        ? this.repository.findOrder(session.tenantId, journey.orderId)
        : Promise.resolve(null),
    ]);
    const settlement = settlementViewFromJourney(journey, order);
    return {
      journeyId: journey.id,
      journeyStatus: journey.status,
      detection: detectionView(policy),
      basket: summariseBasket(lines),
      // An exit knows WHY it stopped; a plain read can only re-derive the one
      // reason the journey row can mean. Prefer the exit's answer when it has
      // one, and never overwrite a derived reason with null.
      settlement: blockedBy ? { ...settlement, blockedBy } : settlement,
    };
  }
}
