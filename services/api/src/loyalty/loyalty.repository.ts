import { Injectable } from '@nestjs/common';
import {
  LoyaltyAccount,
  LoyaltyAccountStatus,
  LoyaltyPointMovement,
  LoyaltyPointMovementType,
  Prisma,
  Promotion,
  PromotionAudience,
  PromotionChangeReason,
  PromotionStatus,
  PromotionVersion,
  PromotionVersionStatus,
} from '@prisma/client';
import { AuditEntry, AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import { loyaltyLedgerAdvisoryLockKey } from './loyalty.constants';
import {
  LedgerRejection,
  PromotionCandidate,
  projectLedgerAppend,
} from './loyalty.logic';

/** Promotion version statuses that can ever apply (see loyalty.logic.ts). */
const APPLICABLE: PromotionVersionStatus[] = [
  PromotionVersionStatus.ACTIVE,
  PromotionVersionStatus.SUPERSEDED,
];

export const PROMOTION_VERSION_SUMMARY_SELECT = {
  id: true,
  promotionId: true,
  versionNumber: true,
  status: true,
  effectiveFrom: true,
  effectiveTo: true,
  reason: true,
  note: true,
  activatedAt: true,
  activatedById: true,
  createdById: true,
  supersededByVersionId: true,
  rolledBackFromVersionId: true,
  createdAt: true,
} satisfies Prisma.PromotionVersionSelect;

export type PromotionVersionSummary = Prisma.PromotionVersionGetPayload<{
  select: typeof PROMOTION_VERSION_SUMMARY_SELECT;
}>;

export const PROMOTION_DETAIL_INCLUDE = {
  location: { select: { id: true, code: true, name: true } },
  versions: {
    select: PROMOTION_VERSION_SUMMARY_SELECT,
    orderBy: { versionNumber: 'desc' },
  },
} satisfies Prisma.PromotionInclude;

export type PromotionDetail = Prisma.PromotionGetPayload<{
  include: typeof PROMOTION_DETAIL_INCLUDE;
}>;

export type PromotionRuleWithProduct = Prisma.PromotionRuleGetPayload<{
  include: { product: { select: { id: true; sku: true; name: true } } };
}>;

/** An account plus its DERIVED balance. The balance is never a column. */
export interface LoyaltyAccountWithBalance {
  account: LoyaltyAccount;
  pointsBalance: number;
  movementCount: number;
}

export type CreateAccountRejection = 'code-taken';

export type AccountRejection = 'account-not-found' | 'account-closed';

export type LedgerAppendRejection =
  | 'account-not-found'
  | 'account-not-active'
  | 'idempotency-key-conflict'
  | LedgerRejection;

export interface AppendMovementInput {
  type: LoyaltyPointMovementType;
  /** Signed: accruals positive, redemptions negative. Never zero. */
  points: number;
  reasonCode: string;
  note?: string;
  orderId?: string;
  promotionVersionId?: string;
  idempotencyKey: string;
  createdById?: string | null;
}

export interface AppendMovementResult {
  movement: LoyaltyPointMovement;
  pointsBalance: number;
  /** True when the idempotency key replayed an earlier append. */
  replayed: boolean;
}

export type CreatePromotionRejection = 'code-taken' | 'location-not-found';

export type PromotionVersionRejection =
  | 'promotion-not-found'
  | 'promotion-archived'
  | 'version-not-found'
  | 'version-not-draft'
  | 'version-empty'
  | 'version-not-activatable'
  | 'source-version-not-applicable'
  | 'effective-from-not-after-active'
  | 'product-not-found'
  | 'copy-source-not-found';

export interface PromotionActivationAuditBuilders {
  activated: (before: PromotionVersion, after: PromotionVersion) => AuditEntry;
  superseded?: (
    before: PromotionVersion,
    after: PromotionVersion,
  ) => AuditEntry;
}

export interface PromotionRollbackAuditBuilders
  extends PromotionActivationAuditBuilders {
  created: (version: PromotionVersion) => AuditEntry;
}

export interface PromotionRuleInput {
  productId?: string | null;
  kind: Prisma.PromotionRuleCreateManyInput['kind'];
  value: number;
  maxDiscountMinor?: number | null;
}

/**
 * Data access for loyalty accounts, the points ledger, and promotions.
 *
 * Every method takes `tenantId` first and scopes every query with it
 * (AGENTS.md tenancy invariant), and every DESTRUCTIVE write carries the
 * tenant IN the write predicate through the `id_tenantId` composite key —
 * never relying on the tenant-scoped lookup that preceded it. That rule is
 * pinned by locations.repository.spec.ts and, for this module, by
 * loyalty.repository.spec.ts.
 *
 * NOTHING HERE TOUCHES A PRICE TABLE. Not `priceBook`, not
 * `priceBookVersion`, not `priceBookEntry` — a promotion composes on top of a
 * resolved price and never writes one. promotion-price-immutability.spec.ts
 * hands this class a Prisma stand-in whose price models throw on ANY property
 * access and drives the whole promotion lifecycle through it.
 */
@Injectable()
export class LoyaltyRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  // ------------------------------------------------------------- accounts

  createAccount(
    tenantId: string,
    data: {
      memberCode: string;
      displayName?: string | null;
      createdById?: string | null;
    },
    buildAuditEntry: (account: LoyaltyAccount) => AuditEntry,
  ): Promise<LoyaltyAccount | CreateAccountRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const clash = await tx.loyaltyAccount.findFirst({
        where: { tenantId: scoped, memberCode: data.memberCode },
        select: { id: true },
      });
      if (clash) {
        return 'code-taken' as const;
      }
      const created = await tx.loyaltyAccount.create({
        data: {
          tenantId: scoped,
          memberCode: data.memberCode,
          displayName: data.displayName ?? null,
          createdById: data.createdById ?? null,
        },
      });
      await this.auditLog.record(buildAuditEntry(created), tx);
      return created;
    });
  }

  async findAccounts(
    tenantId: string,
    filter: { status?: LoyaltyAccountStatus; memberCode?: string },
    page: { skip: number; take: number },
  ): Promise<{ items: LoyaltyAccountWithBalance[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.memberCode ? { memberCode: filter.memberCode } : {}),
    });
    const [accounts, total] = await Promise.all([
      this.prisma.loyaltyAccount.findMany({
        where,
        orderBy: [{ memberCode: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.loyaltyAccount.count({ where }),
    ]);
    const items = await Promise.all(
      accounts.map(async (account) => ({
        account,
        ...(await this.deriveBalance(tenantId, account.id)),
      })),
    );
    return { items, total };
  }

  async findAccountById(
    tenantId: string,
    id: string,
  ): Promise<LoyaltyAccountWithBalance | null> {
    const account = await this.prisma.loyaltyAccount.findFirst({
      where: this.scope(tenantId, { id }),
    });
    if (!account) {
      return null;
    }
    return { account, ...(await this.deriveBalance(tenantId, account.id)) };
  }

  /**
   * The balance is ALWAYS a SUM over the append-only ledger. There is no
   * balance column to drift, and no code path anywhere that increments one.
   */
  private async deriveBalance(
    tenantId: string,
    accountId: string,
    client?: Prisma.TransactionClient,
  ): Promise<{ pointsBalance: number; movementCount: number }> {
    const db = client ?? this.prisma;
    const aggregate = await db.loyaltyPointMovement.aggregate({
      where: { tenantId, accountId },
      _sum: { points: true },
      _count: { _all: true },
    });
    return {
      pointsBalance: aggregate._sum.points ?? 0,
      movementCount: aggregate._count._all ?? 0,
    };
  }

  updateAccount(
    tenantId: string,
    id: string,
    data: { displayName?: string | null; status?: LoyaltyAccountStatus },
    buildAuditEntry: (
      before: LoyaltyAccount,
      after: LoyaltyAccount,
    ) => AuditEntry,
  ): Promise<LoyaltyAccount | AccountRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.loyaltyAccount.findFirst({
        where: { id, tenantId: scoped },
      });
      if (!before) {
        return 'account-not-found' as const;
      }
      if (before.status === LoyaltyAccountStatus.CLOSED) {
        return 'account-closed' as const;
      }
      const after = await tx.loyaltyAccount.update({
        // Tenant IN the write predicate, not merely in the lookup above.
        where: { id_tenantId: { id: before.id, tenantId: scoped } },
        data: {
          ...(data.displayName === undefined
            ? {}
            : { displayName: data.displayName }),
          ...(data.status === undefined ? {} : { status: data.status }),
        },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  // -------------------------------------------------------- points ledger

  async findMovements(
    tenantId: string,
    accountId: string,
    page: { skip: number; take: number },
  ): Promise<
    { items: LoyaltyPointMovement[]; total: number } | 'account-not-found'
  > {
    const account = await this.prisma.loyaltyAccount.findFirst({
      where: this.scope(tenantId, { id: accountId }),
      select: { id: true },
    });
    if (!account) {
      return 'account-not-found';
    }
    const where = this.scope(tenantId, { accountId });
    const [items, total] = await Promise.all([
      this.prisma.loyaltyPointMovement.findMany({
        where,
        orderBy: [{ sequenceNumber: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.loyaltyPointMovement.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Appends ONE movement to an account's ledger.
   *
   * The ordering matters and is the whole point of this method:
   *
   *  1. Take the per-account advisory lock, so two concurrent redemptions for
   *     the same account serialize instead of both reading the same tail.
   *  2. Inside the lock, replay the idempotency key. A repeat returns the
   *     ORIGINAL movement — points move once however many times a flaky
   *     client retries.
   *  3. Derive the balance and the next sequence number from the ledger
   *     itself (SUM + MAX), never from a stored counter.
   *  4. Project the append; an overdraw is rejected here as a clean 409.
   *  5. INSERT. The `balanceAfter >= 0` CHECK and the unique
   *     (accountId, sequenceNumber) index make step 4 a convenience, not the
   *     guarantee: if the lock were ever bypassed or the projection were
   *     wrong, the write fails rather than producing a negative balance.
   *
   * Nothing updates or deletes a movement, here or anywhere else — a database
   * trigger rejects both.
   */
  appendMovement(
    tenantId: string,
    accountId: string,
    input: AppendMovementInput,
    buildAuditEntry: (
      movement: LoyaltyPointMovement,
      balanceAfter: number,
    ) => AuditEntry,
  ): Promise<AppendMovementResult | LedgerAppendRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${loyaltyLedgerAdvisoryLockKey(
        scoped,
        accountId,
      )}))::text`;
      const account = await tx.loyaltyAccount.findFirst({
        where: { id: accountId, tenantId: scoped },
        select: { id: true, status: true },
      });
      if (!account) {
        return 'account-not-found' as const;
      }
      if (account.status !== LoyaltyAccountStatus.ACTIVE) {
        // A suspended or closed account neither earns nor spends. History is
        // untouched; only new movements are refused.
        return 'account-not-active' as const;
      }
      const replay = await tx.loyaltyPointMovement.findFirst({
        where: { tenantId: scoped, idempotencyKey: input.idempotencyKey },
      });
      if (replay) {
        if (replay.accountId !== account.id) {
          // The same key pointing at a different account is a client bug, not
          // a replay — answering with the other account's movement would leak
          // it.
          return 'idempotency-key-conflict' as const;
        }
        const { pointsBalance } = await this.deriveBalance(
          scoped,
          account.id,
          tx,
        );
        return { movement: replay, pointsBalance, replayed: true };
      }
      const aggregate = await tx.loyaltyPointMovement.aggregate({
        where: { tenantId: scoped, accountId: account.id },
        _sum: { points: true },
        _max: { sequenceNumber: true },
      });
      const projected = projectLedgerAppend(
        {
          sequenceNumber: aggregate._max.sequenceNumber ?? 0,
          balance: aggregate._sum.points ?? 0,
        },
        input.points,
      );
      if (typeof projected === 'string') {
        return projected;
      }
      const movement = await tx.loyaltyPointMovement.create({
        data: {
          tenantId: scoped,
          accountId: account.id,
          sequenceNumber: projected.sequenceNumber,
          type: input.type,
          points: input.points,
          balanceAfter: projected.balanceAfter,
          reasonCode: input.reasonCode,
          note: input.note ?? null,
          orderId: input.orderId ?? null,
          promotionVersionId: input.promotionVersionId ?? null,
          idempotencyKey: input.idempotencyKey,
          createdById: input.createdById ?? null,
        },
      });
      await this.auditLog.record(
        buildAuditEntry(movement, projected.balanceAfter),
        tx,
      );
      return {
        movement,
        pointsBalance: projected.balanceAfter,
        replayed: false,
      };
    });
  }

  // ----------------------------------------------------------- promotions

  createPromotion(
    tenantId: string,
    data: {
      code: string;
      name: string;
      audience: PromotionAudience;
      locationId?: string | null;
      priority: number;
      createdById?: string | null;
    },
    buildAuditEntry: (promotion: Promotion) => AuditEntry,
  ): Promise<Promotion | CreatePromotionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      if (data.locationId) {
        const location = await tx.location.findFirst({
          where: { id: data.locationId, tenantId: scoped },
          select: { id: true },
        });
        if (!location) {
          return 'location-not-found' as const;
        }
      }
      const clash = await tx.promotion.findFirst({
        where: { tenantId: scoped, code: data.code },
        select: { id: true },
      });
      if (clash) {
        return 'code-taken' as const;
      }
      const created = await tx.promotion.create({
        data: {
          tenantId: scoped,
          code: data.code,
          name: data.name,
          audience: data.audience,
          locationId: data.locationId ?? null,
          priority: data.priority,
          createdById: data.createdById ?? null,
        },
      });
      await this.auditLog.record(buildAuditEntry(created), tx);
      return created;
    });
  }

  async findPromotions(
    tenantId: string,
    filter: {
      status?: PromotionStatus;
      audience?: PromotionAudience;
      locationId?: string;
    },
    page: { skip: number; take: number },
  ): Promise<{ items: PromotionDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.audience ? { audience: filter.audience } : {}),
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
    });
    const [items, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        include: PROMOTION_DETAIL_INCLUDE,
        orderBy: [{ code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.promotion.count({ where }),
    ]);
    return { items, total };
  }

  findPromotionById(
    tenantId: string,
    id: string,
  ): Promise<PromotionDetail | null> {
    return this.prisma.promotion.findFirst({
      where: this.scope(tenantId, { id }),
      include: PROMOTION_DETAIL_INCLUDE,
    });
  }

  updatePromotion(
    tenantId: string,
    id: string,
    data: { name?: string; status?: PromotionStatus; priority?: number },
    buildAuditEntry: (before: Promotion, after: Promotion) => AuditEntry,
  ): Promise<Promotion | 'promotion-not-found'> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.promotion.findFirst({
        where: { id, tenantId: scoped },
      });
      if (!before) {
        return 'promotion-not-found' as const;
      }
      const after = await tx.promotion.update({
        where: { id_tenantId: { id: before.id, tenantId: scoped } },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.status === undefined ? {} : { status: data.status }),
          ...(data.priority === undefined ? {} : { priority: data.priority }),
        },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  createVersion(
    tenantId: string,
    promotionId: string,
    data: {
      reason: PromotionChangeReason;
      note?: string;
      effectiveFrom: Date;
      copyFromVersionId?: string;
      createdById?: string | null;
    },
    buildAuditEntry: (version: PromotionVersion) => AuditEntry,
  ): Promise<PromotionVersion | PromotionVersionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.findFirst({
        where: { id: promotionId, tenantId: scoped },
        select: { id: true, status: true },
      });
      if (!promotion) {
        return 'promotion-not-found' as const;
      }
      if (promotion.status === PromotionStatus.ARCHIVED) {
        return 'promotion-archived' as const;
      }
      let copiedRules: {
        productId: string | null;
        kind: PromotionRuleInput['kind'];
        value: number;
        maxDiscountMinor: number | null;
      }[] = [];
      if (data.copyFromVersionId) {
        const source = await tx.promotionVersion.findFirst({
          where: {
            id: data.copyFromVersionId,
            tenantId: scoped,
            promotionId: promotion.id,
          },
          select: {
            rules: {
              select: {
                productId: true,
                kind: true,
                value: true,
                maxDiscountMinor: true,
              },
            },
          },
        });
        if (!source) {
          return 'copy-source-not-found' as const;
        }
        copiedRules = source.rules;
      }
      const highest = await tx.promotionVersion.aggregate({
        where: { tenantId: scoped, promotionId: promotion.id },
        _max: { versionNumber: true },
      });
      const version = await tx.promotionVersion.create({
        data: {
          tenantId: scoped,
          promotionId: promotion.id,
          versionNumber: (highest._max.versionNumber ?? 0) + 1,
          status: PromotionVersionStatus.DRAFT,
          effectiveFrom: data.effectiveFrom,
          reason: data.reason,
          note: data.note,
          createdById: data.createdById ?? null,
        },
      });
      if (copiedRules.length > 0) {
        await tx.promotionRule.createMany({
          data: copiedRules.map((rule) => ({
            tenantId: scoped,
            versionId: version.id,
            productId: rule.productId,
            kind: rule.kind,
            value: rule.value,
            maxDiscountMinor: rule.maxDiscountMinor,
          })),
        });
      }
      await this.auditLog.record(buildAuditEntry(version), tx);
      return version;
    });
  }

  findVersion(
    tenantId: string,
    promotionId: string,
    versionId: string,
  ): Promise<PromotionVersionSummary | null> {
    return this.prisma.promotionVersion.findFirst({
      where: this.scope(tenantId, { id: versionId, promotionId }),
      select: PROMOTION_VERSION_SUMMARY_SELECT,
    });
  }

  async findRules(
    tenantId: string,
    promotionId: string,
    versionId: string,
  ): Promise<PromotionRuleWithProduct[] | 'version-not-found'> {
    const version = await this.findVersion(tenantId, promotionId, versionId);
    if (!version) {
      return 'version-not-found';
    }
    return this.prisma.promotionRule.findMany({
      where: this.scope(tenantId, { versionId }),
      include: { product: { select: { id: true, sku: true, name: true } } },
      orderBy: [{ productId: 'asc' }],
    });
  }

  /**
   * Replaces the rule set of a DRAFT version.
   *
   * The DRAFT check is the immutability invariant, and it is the same one
   * price entries have: once a version has been activated its rules are
   * frozen forever, because superseded versions still explain what an old
   * order was charged.
   */
  setRules(
    tenantId: string,
    promotionId: string,
    versionId: string,
    rules: readonly PromotionRuleInput[],
    buildAuditEntry: (
      version: PromotionVersion,
      count: number,
    ) => AuditEntry,
  ): Promise<PromotionVersion | PromotionVersionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.findFirst({
        where: { id: promotionId, tenantId: scoped },
        select: { id: true, status: true },
      });
      if (!promotion) {
        return 'promotion-not-found' as const;
      }
      if (promotion.status === PromotionStatus.ARCHIVED) {
        return 'promotion-archived' as const;
      }
      const version = await tx.promotionVersion.findFirst({
        where: {
          id: versionId,
          tenantId: scoped,
          promotionId: promotion.id,
        },
      });
      if (!version) {
        return 'version-not-found' as const;
      }
      if (version.status !== PromotionVersionStatus.DRAFT) {
        return 'version-not-draft' as const;
      }
      const productIds = [
        ...new Set(
          rules
            .map((rule) => rule.productId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      if (productIds.length > 0) {
        const found = await tx.product.count({
          where: { tenantId: scoped, id: { in: productIds } },
        });
        if (found !== productIds.length) {
          return 'product-not-found' as const;
        }
      }
      await tx.promotionRule.deleteMany({
        where: { tenantId: scoped, versionId: version.id },
      });
      await tx.promotionRule.createMany({
        data: rules.map((rule) => ({
          tenantId: scoped,
          versionId: version.id,
          productId: rule.productId ?? null,
          kind: rule.kind,
          value: rule.value,
          maxDiscountMinor: rule.maxDiscountMinor ?? null,
        })),
      });
      await this.auditLog.record(buildAuditEntry(version, rules.length), tx);
      return version;
    });
  }

  activateVersion(
    tenantId: string,
    promotionId: string,
    versionId: string,
    data: { effectiveFrom: Date; note?: string; activatedById?: string | null },
    builders: PromotionActivationAuditBuilders,
  ): Promise<PromotionVersion | PromotionVersionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) =>
      this.activateWithin(tx, scoped, promotionId, versionId, data, builders),
    );
  }

  /**
   * Reversibility without rewriting: a rollback copies an old version's rules
   * into a NEW version and activates it, so promotion history reads forward
   * and the source row is never resurrected or edited. Exactly the shape
   * pricing uses for a price rollback.
   */
  rollbackToVersion(
    tenantId: string,
    promotionId: string,
    sourceVersionId: string,
    data: { note?: string; actorId?: string | null; at: Date },
    builders: PromotionRollbackAuditBuilders,
  ): Promise<PromotionVersion | PromotionVersionRejection> {
    const scoped = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.findFirst({
        where: { id: promotionId, tenantId: scoped },
        select: { id: true, status: true },
      });
      if (!promotion) {
        return 'promotion-not-found' as const;
      }
      if (promotion.status === PromotionStatus.ARCHIVED) {
        return 'promotion-archived' as const;
      }
      const source = await tx.promotionVersion.findFirst({
        where: {
          id: sourceVersionId,
          tenantId: scoped,
          promotionId: promotion.id,
        },
        select: {
          id: true,
          status: true,
          rules: {
            select: {
              productId: true,
              kind: true,
              value: true,
              maxDiscountMinor: true,
            },
          },
        },
      });
      if (!source) {
        return 'version-not-found' as const;
      }
      if (!APPLICABLE.includes(source.status)) {
        // Rolling back to a draft would activate a discount nobody approved;
        // rolling back to an archived version would resurrect a decision that
        // was explicitly abandoned.
        return 'source-version-not-applicable' as const;
      }
      if (source.rules.length === 0) {
        return 'version-empty' as const;
      }
      const highest = await tx.promotionVersion.aggregate({
        where: { tenantId: scoped, promotionId: promotion.id },
        _max: { versionNumber: true },
      });
      const copy = await tx.promotionVersion.create({
        data: {
          tenantId: scoped,
          promotionId: promotion.id,
          versionNumber: (highest._max.versionNumber ?? 0) + 1,
          status: PromotionVersionStatus.DRAFT,
          effectiveFrom: data.at,
          reason: PromotionChangeReason.ROLLBACK,
          note: data.note,
          rolledBackFromVersionId: source.id,
          createdById: data.actorId ?? null,
        },
      });
      await tx.promotionRule.createMany({
        data: source.rules.map((rule) => ({
          tenantId: scoped,
          versionId: copy.id,
          productId: rule.productId,
          kind: rule.kind,
          value: rule.value,
          maxDiscountMinor: rule.maxDiscountMinor,
        })),
      });
      await this.auditLog.record(builders.created(copy), tx);
      return this.activateWithin(
        tx,
        scoped,
        promotion.id,
        copy.id,
        { effectiveFrom: data.at, activatedById: data.actorId },
        builders,
      );
    });
  }

  private async activateWithin(
    tx: Prisma.TransactionClient,
    tenantId: string,
    promotionId: string,
    versionId: string,
    data: { effectiveFrom: Date; note?: string; activatedById?: string | null },
    builders: PromotionActivationAuditBuilders,
  ): Promise<PromotionVersion | PromotionVersionRejection> {
    const promotion = await tx.promotion.findFirst({
      where: { id: promotionId, tenantId },
      select: { id: true, status: true },
    });
    if (!promotion) {
      return 'promotion-not-found' as const;
    }
    if (promotion.status === PromotionStatus.ARCHIVED) {
      return 'promotion-archived' as const;
    }
    const target = await tx.promotionVersion.findFirst({
      where: { id: versionId, tenantId, promotionId: promotion.id },
    });
    if (!target) {
      return 'version-not-found' as const;
    }
    if (target.status !== PromotionVersionStatus.DRAFT) {
      return 'version-not-activatable' as const;
    }
    const ruleCount = await tx.promotionRule.count({
      where: { tenantId, versionId: target.id },
    });
    if (ruleCount === 0) {
      // An empty version would be an ACTIVE promotion that discounts nothing,
      // which is indistinguishable from a bug when an operator reads the list.
      return 'version-empty' as const;
    }
    const current = await tx.promotionVersion.findFirst({
      where: {
        tenantId,
        promotionId: promotion.id,
        status: PromotionVersionStatus.ACTIVE,
      },
    });
    if (current) {
      if (data.effectiveFrom.getTime() <= current.effectiveFrom.getTime()) {
        return 'effective-from-not-after-active' as const;
      }
      const supersededAfter = await tx.promotionVersion.update({
        where: { id_tenantId: { id: current.id, tenantId } },
        data: {
          status: PromotionVersionStatus.SUPERSEDED,
          effectiveTo: data.effectiveFrom,
          supersededByVersionId: target.id,
        },
      });
      if (builders.superseded) {
        await this.auditLog.record(
          builders.superseded(current, supersededAfter),
          tx,
        );
      }
    }
    const after = await tx.promotionVersion.update({
      where: { id_tenantId: { id: target.id, tenantId } },
      data: {
        status: PromotionVersionStatus.ACTIVE,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: null,
        activatedAt: new Date(),
        activatedById: data.activatedById ?? null,
        note: data.note ?? target.note,
      },
    });
    await this.auditLog.record(builders.activated(target, after), tx);
    return after;
  }

  // ----------------------------------------------------------- resolution

  /**
   * True when the basket's loyalty account exists, belongs to this tenant and
   * is ACTIVE. A suspended or closed member wins no member-only promotion.
   */
  async isActiveMember(
    tenantId: string,
    accountId: string,
    client?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const scoped = this.requireTenantId(tenantId);
    const db = client ?? this.prisma;
    const account = await db.loyaltyAccount.findFirst({
      where: {
        id: accountId,
        tenantId: scoped,
        status: LoyaltyAccountStatus.ACTIVE,
      },
      select: { id: true },
    });
    return account !== null;
  }

  /**
   * Loads every promotion version that could apply to these products at `at`.
   * Which one wins is left to loyalty.logic.ts so the decision stays pure and
   * testable; this only narrows what the database has to hand over.
   *
   * `client` lets checkout evaluate promotions INSIDE its own line
   * transaction, under the same locks that resolved the price.
   */
  async findPromotionCandidates(
    tenantId: string,
    productIds: readonly string[],
    at: Date,
    locationId?: string | null,
    client?: Prisma.TransactionClient,
  ): Promise<PromotionCandidate[]> {
    const scoped = this.requireTenantId(tenantId);
    if (productIds.length === 0) {
      return [];
    }
    const db = client ?? this.prisma;
    const rows = await db.promotionVersion.findMany({
      where: {
        tenantId: scoped,
        status: { in: APPLICABLE },
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        promotion: {
          tenantId: scoped,
          status: PromotionStatus.ACTIVE,
          // A location-scoped promotion of ANOTHER location can never apply,
          // so it is excluded here rather than in the pure selector.
          OR: locationId
            ? [{ locationId: null }, { locationId }]
            : [{ locationId: null }],
        },
        rules: {
          some: {
            tenantId: scoped,
            OR: [{ productId: null }, { productId: { in: [...productIds] } }],
          },
        },
      },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        promotion: {
          select: {
            id: true,
            code: true,
            locationId: true,
            audience: true,
            priority: true,
          },
        },
        rules: {
          where: {
            OR: [{ productId: null }, { productId: { in: [...productIds] } }],
          },
          select: {
            id: true,
            productId: true,
            kind: true,
            value: true,
            maxDiscountMinor: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      promotionId: row.promotion.id,
      promotionCode: row.promotion.code,
      promotionLocationId: row.promotion.locationId,
      audience: row.promotion.audience,
      priority: row.promotion.priority,
      promotionVersionId: row.id,
      versionNumber: row.versionNumber,
      status: row.status as 'ACTIVE' | 'SUPERSEDED',
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      rules: row.rules.map((rule) => ({
        ruleId: rule.id,
        productId: rule.productId,
        kind: rule.kind,
        value: rule.value,
        maxDiscountMinor: rule.maxDiscountMinor,
      })),
    }));
  }
}
