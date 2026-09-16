import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  LoyaltyAccount,
  LoyaltyAccountStatus,
  LoyaltyPointMovement,
  LoyaltyPointMovementType,
  Promotion,
  PromotionAudience,
  PromotionChangeReason,
  PromotionStatus,
  PromotionVersion,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  CreateLoyaltyAccountDto,
  QueryLoyaltyAccountsDto,
  QueryPointMovementsDto,
  UpdateLoyaltyAccountDto,
} from './dto/loyalty-account.dto';
import {
  AccruePointsDto,
  AdjustPointsDto,
  RedeemPointsDto,
} from './dto/points.dto';
import {
  ActivatePromotionVersionDto,
  CreatePromotionDto,
  CreatePromotionVersionDto,
  QueryPromotionsDto,
  QuotePriceDto,
  RollbackPromotionVersionDto,
  SetPromotionRulesDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import { LOYALTY_DEFAULT_TAKE } from './loyalty.constants';
import {
  normalizeMemberCode,
  normalizePromotionCode,
  normalizeReasonCode,
  signedPoints,
} from './loyalty.logic';
import {
  AppendMovementResult,
  LoyaltyAccountWithBalance,
  LoyaltyRepository,
  PromotionDetail,
  PromotionRuleWithProduct,
  PromotionVersionRejection,
  PromotionVersionSummary,
} from './loyalty.repository';
import {
  PriceQuote,
  PromotionResolutionService,
} from './promotion-resolution.service';

/**
 * Operator-supplied free text is persisted AND copied into AuditLog.reason,
 * which audit redaction does not cover. Screen it with the strict predicate
 * for the same reason pricing and the inventory ledger do: a pasted PAN or
 * credential in a justification field would be retained forever (AGENTS.md
 * payments invariant).
 */
function assertSafeText(value: string, field: string): void {
  if (containsSensitiveFreeText(value)) {
    throw new BadRequestException(
      `${field} must not contain credential- or payment-bearing values`,
    );
  }
}

/** Caller-supplied ids echoed into errors land in logs — redact unsafe ones. */
function safeErrorEntityId(id: string): string {
  return containsSensitiveFreeText(id) ? '[REDACTED]' : id;
}

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly repository: LoyaltyRepository,
    private readonly promotions: PromotionResolutionService,
  ) {}

  // ------------------------------------------------------------- accounts

  async createAccount(
    tenantId: string,
    dto: CreateLoyaltyAccountDto,
    actor: AuditActor,
  ): Promise<LoyaltyAccount> {
    const memberCode = normalizeMemberCode(dto.memberCode);
    const displayName = dto.displayName?.trim();
    if (displayName) {
      assertSafeText(displayName, 'displayName');
    }
    const result = await this.repository.createAccount(
      tenantId,
      { memberCode, displayName, createdById: actor.id },
      (account) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'LoyaltyAccount',
          entityId: account.id,
          after: account,
          reason: `Loyalty account ${account.memberCode} enrolled`,
        }),
    );
    if (result === 'code-taken') {
      throw new ConflictException(
        `A loyalty account with member code "${memberCode}" already exists in this tenant`,
      );
    }
    return result;
  }

  findAccounts(
    tenantId: string,
    query: QueryLoyaltyAccountsDto,
  ): Promise<{ items: LoyaltyAccountWithBalance[]; total: number }> {
    return this.repository.findAccounts(
      tenantId,
      {
        status: query.status as LoyaltyAccountStatus | undefined,
        memberCode: query.memberCode
          ? normalizeMemberCode(query.memberCode)
          : undefined,
      },
      {
        skip: query.skip ?? 0,
        take: query.take ?? LOYALTY_DEFAULT_TAKE,
      },
    );
  }

  async findAccountById(
    tenantId: string,
    id: string,
  ): Promise<LoyaltyAccountWithBalance> {
    const account = await this.repository.findAccountById(tenantId, id);
    if (!account) {
      throw new NotFoundException(
        `Loyalty account "${safeErrorEntityId(id)}" not found`,
      );
    }
    return account;
  }

  async updateAccount(
    tenantId: string,
    id: string,
    dto: UpdateLoyaltyAccountDto,
    actor: AuditActor,
  ): Promise<LoyaltyAccount> {
    if (dto.displayName === undefined && dto.status === undefined) {
      throw new BadRequestException(
        'Provide a displayName and/or a status to change',
      );
    }
    const displayName = dto.displayName?.trim();
    if (displayName) {
      assertSafeText(displayName, 'displayName');
    }
    const result = await this.repository.updateAccount(
      tenantId,
      id,
      {
        ...(displayName === undefined ? {} : { displayName }),
        status: dto.status as LoyaltyAccountStatus | undefined,
      },
      (before, after) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'LoyaltyAccount',
          entityId: after.id,
          before,
          after,
          reason: `Loyalty account ${after.memberCode} updated`,
        }),
    );
    if (result === 'account-not-found') {
      throw new NotFoundException(
        `Loyalty account "${safeErrorEntityId(id)}" not found`,
      );
    }
    if (result === 'account-closed') {
      throw new ConflictException(
        'A CLOSED loyalty account cannot be changed — enrol a new account instead',
      );
    }
    return result;
  }

  // -------------------------------------------------------- points ledger

  findMovements(
    tenantId: string,
    accountId: string,
    query: QueryPointMovementsDto,
  ): Promise<{ items: LoyaltyPointMovement[]; total: number }> {
    return this.repository
      .findMovements(tenantId, accountId, {
        skip: query.skip ?? 0,
        take: query.take ?? LOYALTY_DEFAULT_TAKE,
      })
      .then((result) => {
        if (result === 'account-not-found') {
          throw new NotFoundException(
            `Loyalty account "${safeErrorEntityId(accountId)}" not found`,
          );
        }
        return result;
      });
  }

  accrue(
    tenantId: string,
    accountId: string,
    dto: AccruePointsDto,
    actor: AuditActor,
  ): Promise<AppendMovementResult> {
    return this.append(
      tenantId,
      accountId,
      LoyaltyPointMovementType.ACCRUAL,
      dto.points,
      dto,
      actor,
    );
  }

  redeem(
    tenantId: string,
    accountId: string,
    dto: RedeemPointsDto,
    actor: AuditActor,
  ): Promise<AppendMovementResult> {
    return this.append(
      tenantId,
      accountId,
      LoyaltyPointMovementType.REDEMPTION,
      dto.points,
      dto,
      actor,
    );
  }

  adjust(
    tenantId: string,
    accountId: string,
    dto: AdjustPointsDto,
    actor: AuditActor,
  ): Promise<AppendMovementResult> {
    return this.append(
      tenantId,
      accountId,
      dto.type as LoyaltyPointMovementType,
      dto.points,
      dto,
      actor,
    );
  }

  private async append(
    tenantId: string,
    accountId: string,
    type: LoyaltyPointMovementType,
    magnitudeOrSigned: number,
    dto: {
      reasonCode: string;
      note?: string;
      orderId?: string;
      idempotencyKey: string;
    },
    actor: AuditActor,
  ): Promise<AppendMovementResult> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeText(note, 'note');
    }
    const reasonCode = normalizeReasonCode(dto.reasonCode);
    assertSafeText(reasonCode, 'reasonCode');
    const points = signedPoints(type, magnitudeOrSigned);
    const result = await this.repository.appendMovement(
      tenantId,
      accountId,
      {
        type,
        points,
        reasonCode,
        note,
        orderId: dto.orderId,
        idempotencyKey: dto.idempotencyKey,
        createdById: actor.id,
      },
      (movement, balanceAfter) =>
        this.audit(tenantId, actor, {
          action: AuditAction.POINTS_MOVEMENT,
          entityType: 'LoyaltyPointMovement',
          entityId: movement.id,
          after: movement,
          reason:
            note ??
            `${movement.type} of ${movement.points} points (${reasonCode}); balance ${balanceAfter}`,
        }),
    );
    if (typeof result !== 'string') {
      return result;
    }
    switch (result) {
      case 'account-not-found':
        throw new NotFoundException(
          `Loyalty account "${safeErrorEntityId(accountId)}" not found`,
        );
      case 'account-not-active':
        throw new ConflictException(
          'Only an ACTIVE loyalty account can move points',
        );
      case 'idempotency-key-conflict':
        throw new ConflictException(
          'That idempotencyKey was already used for a different loyalty account',
        );
      case 'insufficient-points':
        throw new ConflictException(
          'The account does not have enough points — a redemption can never overdraw',
        );
      case 'points-overflow':
        throw new ConflictException(
          'That movement would push the balance past the supported maximum',
        );
      case 'zero-points':
        throw new BadRequestException('points must not be zero');
      default: {
        const exhaustive: never = result;
        throw new ConflictException(`Points movement rejected: ${exhaustive}`);
      }
    }
  }

  // ----------------------------------------------------------- promotions

  async createPromotion(
    tenantId: string,
    dto: CreatePromotionDto,
    actor: AuditActor,
  ): Promise<Promotion> {
    const code = normalizePromotionCode(dto.code);
    const name = dto.name.trim();
    assertSafeText(name, 'name');
    const result = await this.repository.createPromotion(
      tenantId,
      {
        code,
        name,
        audience: (dto.audience ?? 'ALL_SHOPPERS') as PromotionAudience,
        locationId: dto.locationId,
        priority: dto.priority ?? 0,
        createdById: actor.id,
      },
      (promotion) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'Promotion',
          entityId: promotion.id,
          after: promotion,
          reason: `Promotion ${promotion.code} created`,
        }),
    );
    if (result === 'code-taken') {
      throw new ConflictException(
        `A promotion with code "${code}" already exists in this tenant`,
      );
    }
    if (result === 'location-not-found') {
      throw new NotFoundException(
        `Location "${safeErrorEntityId(dto.locationId ?? '')}" not found`,
      );
    }
    return result;
  }

  findPromotions(
    tenantId: string,
    query: QueryPromotionsDto,
  ): Promise<{ items: PromotionDetail[]; total: number }> {
    return this.repository.findPromotions(
      tenantId,
      {
        status: query.status as PromotionStatus | undefined,
        audience: query.audience as PromotionAudience | undefined,
        locationId: query.locationId,
      },
      { skip: query.skip ?? 0, take: query.take ?? LOYALTY_DEFAULT_TAKE },
    );
  }

  async findPromotionById(
    tenantId: string,
    id: string,
  ): Promise<PromotionDetail> {
    const promotion = await this.repository.findPromotionById(tenantId, id);
    if (!promotion) {
      throw new NotFoundException(
        `Promotion "${safeErrorEntityId(id)}" not found`,
      );
    }
    return promotion;
  }

  async updatePromotion(
    tenantId: string,
    id: string,
    dto: UpdatePromotionDto,
    actor: AuditActor,
  ): Promise<Promotion> {
    if (
      dto.name === undefined &&
      dto.status === undefined &&
      dto.priority === undefined
    ) {
      throw new BadRequestException(
        'Provide a name, status and/or priority to change',
      );
    }
    const name = dto.name?.trim();
    if (name) {
      assertSafeText(name, 'name');
    }
    const result = await this.repository.updatePromotion(
      tenantId,
      id,
      {
        name,
        status: dto.status as PromotionStatus | undefined,
        priority: dto.priority,
      },
      (before, after) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'Promotion',
          entityId: after.id,
          before,
          after,
          reason: `Promotion ${after.code} updated`,
        }),
    );
    if (result === 'promotion-not-found') {
      throw new NotFoundException(
        `Promotion "${safeErrorEntityId(id)}" not found`,
      );
    }
    return result;
  }

  async createVersion(
    tenantId: string,
    promotionId: string,
    dto: CreatePromotionVersionDto,
    actor: AuditActor,
  ): Promise<PromotionVersion> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeText(note, 'note');
    }
    const effectiveFrom = this.parseInstant(dto.effectiveFrom) ?? new Date();
    const result = await this.repository.createVersion(
      tenantId,
      promotionId,
      {
        reason: (dto.reason ?? 'RULE_CHANGE') as PromotionChangeReason,
        note,
        effectiveFrom,
        copyFromVersionId: dto.copyFromVersionId,
        createdById: actor.id,
      },
      (version) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'PromotionVersion',
          entityId: version.id,
          after: version,
          reason:
            note ?? `Draft promotion version ${version.versionNumber} created`,
        }),
    );
    return this.unwrapVersion(result, promotionId);
  }

  async findVersion(
    tenantId: string,
    promotionId: string,
    versionId: string,
  ): Promise<PromotionVersionSummary> {
    const version = await this.repository.findVersion(
      tenantId,
      promotionId,
      versionId,
    );
    if (!version) {
      throw new NotFoundException(
        `Promotion version "${safeErrorEntityId(versionId)}" not found`,
      );
    }
    return version;
  }

  async findRules(
    tenantId: string,
    promotionId: string,
    versionId: string,
  ): Promise<PromotionRuleWithProduct[]> {
    const rules = await this.repository.findRules(
      tenantId,
      promotionId,
      versionId,
    );
    if (rules === 'version-not-found') {
      throw new NotFoundException(
        `Promotion version "${safeErrorEntityId(versionId)}" not found`,
      );
    }
    return rules;
  }

  async setRules(
    tenantId: string,
    promotionId: string,
    versionId: string,
    dto: SetPromotionRulesDto,
    actor: AuditActor,
  ): Promise<PromotionVersion> {
    const seen = new Set<string>();
    for (const rule of dto.rules) {
      const key = rule.productId ?? '__catalog_wide__';
      if (seen.has(key)) {
        throw new BadRequestException(
          'rules must list each product at most once, and may carry at most ' +
            'one catalog-wide rule',
        );
      }
      seen.add(key);
      if (rule.kind === 'PERCENT_OFF' && rule.value > 10000) {
        throw new BadRequestException(
          'A PERCENT_OFF value is in basis points and cannot exceed 10000 (100%)',
        );
      }
      if (rule.kind !== 'PERCENT_OFF' && rule.maxDiscountMinor !== undefined) {
        throw new BadRequestException(
          'maxDiscountMinor only applies to a PERCENT_OFF rule',
        );
      }
    }
    const result = await this.repository.setRules(
      tenantId,
      promotionId,
      versionId,
      dto.rules.map((rule) => ({
        productId: rule.productId ?? null,
        kind: rule.kind,
        value: rule.value,
        maxDiscountMinor: rule.maxDiscountMinor ?? null,
      })),
      (version, count) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'PromotionVersion',
          entityId: version.id,
          after: { versionId: version.id, ruleCount: count },
          reason: `Draft promotion version ${version.versionNumber} rules replaced (${count})`,
        }),
    );
    return this.unwrapVersion(result, promotionId);
  }

  /**
   * Activation is the moment a discount starts applying to baskets, which is
   * why it is audited as PROMOTION_CHANGE rather than a generic UPDATE.
   *
   * Note what does NOT happen here: no price book is touched, no price
   * version is superseded, no shelf label is re-rendered. A promotion changes
   * what a basket line costs; the price in force — the number on the shelf —
   * is still whatever the pricing module says it is. An operator who wants
   * the shelf to change makes a PRICE version with reason PROMOTION_BASE.
   */
  async activateVersion(
    tenantId: string,
    promotionId: string,
    versionId: string,
    dto: ActivatePromotionVersionDto,
    actor: AuditActor,
  ): Promise<PromotionVersion> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeText(note, 'note');
    }
    const effectiveFrom = this.parseInstant(dto.effectiveFrom) ?? new Date();
    const result = await this.repository.activateVersion(
      tenantId,
      promotionId,
      versionId,
      { effectiveFrom, note, activatedById: actor.id },
      {
        activated: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.PROMOTION_CHANGE,
            entityType: 'PromotionVersion',
            entityId: after.id,
            before,
            after,
            reason: note ?? `Promotion version ${after.versionNumber} activated`,
          }),
        superseded: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'PromotionVersion',
            entityId: after.id,
            before,
            after,
            reason: `Promotion version ${after.versionNumber} superseded`,
          }),
      },
    );
    return this.unwrapVersion(result, promotionId);
  }

  /** Reversibility without rewriting — the same shape as a price rollback. */
  async rollbackToVersion(
    tenantId: string,
    promotionId: string,
    versionId: string,
    dto: RollbackPromotionVersionDto,
    actor: AuditActor,
  ): Promise<PromotionVersion> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeText(note, 'note');
    }
    const result = await this.repository.rollbackToVersion(
      tenantId,
      promotionId,
      versionId,
      { note, actorId: actor.id, at: new Date() },
      {
        created: (version) =>
          this.audit(tenantId, actor, {
            action: AuditAction.ROLLBACK,
            entityType: 'PromotionVersion',
            entityId: version.id,
            after: version,
            reason:
              note ??
              `Promotion version ${version.versionNumber} created by rolling back to ${versionId}`,
          }),
        activated: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.PROMOTION_CHANGE,
            entityType: 'PromotionVersion',
            entityId: after.id,
            before,
            after,
            reason: `Rollback promotion version ${after.versionNumber} activated`,
          }),
        superseded: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'PromotionVersion',
            entityId: after.id,
            before,
            after,
            reason: `Promotion version ${after.versionNumber} superseded by rollback`,
          }),
      },
    );
    return this.unwrapVersion(result, promotionId);
  }

  // ------------------------------------------------------------ quoting

  quote(tenantId: string, dto: QuotePriceDto): Promise<PriceQuote | null> {
    const at = this.parseInstant(dto.at) ?? new Date();
    return this.promotions.quote(tenantId, {
      productId: dto.productId,
      at,
      locationId: dto.locationId,
      loyaltyAccountId: dto.loyaltyAccountId,
    });
  }

  // --------------------------------------------------------------- helpers

  private parseInstant(raw?: string): Date | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Timestamps must be valid ISO-8601');
    }
    return parsed;
  }

  private audit(
    tenantId: string,
    actor: AuditActor,
    entry: Omit<AuditEntry, 'tenantId' | 'actorId' | 'actorEmail'>,
  ): AuditEntry {
    return {
      ...entry,
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email || SYSTEM_ACTOR_EMAIL,
    };
  }

  private unwrapVersion(
    result: PromotionVersion | PromotionVersionRejection,
    promotionId: string,
  ): PromotionVersion {
    if (typeof result !== 'string') {
      return result;
    }
    switch (result) {
      case 'promotion-not-found':
        throw new NotFoundException(
          `Promotion "${safeErrorEntityId(promotionId)}" not found`,
        );
      case 'version-not-found':
      case 'copy-source-not-found':
        throw new NotFoundException('Promotion version not found');
      case 'promotion-archived':
        throw new ConflictException('An ARCHIVED promotion cannot be changed');
      case 'version-not-draft':
        throw new ConflictException(
          'Rules of a version that has been activated are immutable — ' +
            'create a new version instead',
        );
      case 'version-not-activatable':
        throw new ConflictException('Only a DRAFT version can be activated');
      case 'version-empty':
        throw new ConflictException(
          'A version with no rules cannot be activated — it would be an ' +
            'active promotion that discounts nothing',
        );
      case 'source-version-not-applicable':
        throw new ConflictException(
          'Only a version that has actually been active can be rolled back to',
        );
      case 'effective-from-not-after-active':
        throw new ConflictException(
          'effectiveFrom must be strictly after the currently active ' +
            'version’s effectiveFrom',
        );
      case 'product-not-found':
        throw new NotFoundException(
          'One or more products in the rule set do not exist in this tenant',
        );
      default: {
        const exhaustive: never = result;
        throw new ConflictException(`Promotion change rejected: ${exhaustive}`);
      }
    }
  }
}
