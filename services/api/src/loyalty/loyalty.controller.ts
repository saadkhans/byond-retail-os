import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  LoyaltyAccount,
  LoyaltyPointMovement,
  Promotion,
  PromotionVersion,
} from '@prisma/client';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
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
import { LOYALTY_MODULE_CODE } from './loyalty.constants';
import {
  AppendMovementResult,
  LoyaltyAccountWithBalance,
  PromotionDetail,
  PromotionRuleWithProduct,
  PromotionVersionSummary,
} from './loyalty.repository';
import { LoyaltyService } from './loyalty.service';
import { PriceQuote } from './promotion-resolution.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(); a tenantId in the body is rejected by the global
// whitelist ValidationPipe.
@ApiTags('loyalty')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(LOYALTY_MODULE_CODE)
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  // ------------------------------------------------------------- accounts

  @Get('accounts')
  @RequirePermissions('loyalty-account:read')
  @ApiOperation({
    summary: 'List loyalty accounts in the caller’s tenant',
    description:
      'Each account carries its points balance, DERIVED from the ' +
      'append-only ledger. There is no balance column anywhere.',
  })
  listAccounts(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryLoyaltyAccountsDto,
  ): Promise<{ items: LoyaltyAccountWithBalance[]; total: number }> {
    return this.loyalty.findAccounts(tenantId, query);
  }

  @Post('accounts')
  @RequirePermissions('loyalty-account:manage')
  @ApiOperation({ summary: 'Enrol a loyalty account' })
  @ApiCreatedResponse({ description: 'Account enrolled' })
  @ApiConflictResponse({ description: 'The member code is already used' })
  createAccount(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateLoyaltyAccountDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<LoyaltyAccount> {
    return this.loyalty.createAccount(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get('accounts/:id')
  @RequirePermissions('loyalty-account:read')
  @ApiOperation({ summary: 'Read one loyalty account and its balance' })
  @ApiNotFoundResponse({ description: 'No such account in this tenant' })
  findAccount(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<LoyaltyAccountWithBalance> {
    return this.loyalty.findAccountById(tenantId, id);
  }

  @Patch('accounts/:id')
  @RequirePermissions('loyalty-account:manage')
  @ApiOperation({
    summary: 'Update a loyalty account',
    description:
      'CLOSED is terminal. Suspending or closing an account stops new ' +
      'points movements and member-only promotions; it never edits history.',
  })
  updateAccount(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateLoyaltyAccountDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<LoyaltyAccount> {
    return this.loyalty.updateAccount(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  // -------------------------------------------------------- points ledger

  @Get('accounts/:id/movements')
  @RequirePermissions('loyalty-points:read')
  @ApiOperation({
    summary: 'List an account’s points movements, newest first',
    description:
      'The ledger is append-only: a database trigger rejects UPDATE, ' +
      'DELETE and TRUNCATE, so what is listed here is the whole truth.',
  })
  listMovements(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Query() query: QueryPointMovementsDto,
  ): Promise<{ items: LoyaltyPointMovement[]; total: number }> {
    return this.loyalty.findMovements(tenantId, id, query);
  }

  @Post('accounts/:id/accrue')
  @RequirePermissions('loyalty-points:post')
  @ApiOperation({ summary: 'Accrue points (idempotent by idempotencyKey)' })
  @ApiCreatedResponse({ description: 'Movement appended, or replayed' })
  accrue(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: AccruePointsDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<AppendMovementResult> {
    return this.loyalty.accrue(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('accounts/:id/redeem')
  @RequirePermissions('loyalty-points:post')
  @ApiOperation({
    summary: 'Redeem points (idempotent by idempotencyKey)',
    description:
      'Never overdraws: the balance floor is enforced inside the write, so ' +
      'a redemption larger than the balance is a 409 and nothing is ' +
      'appended. A replayed key returns the ORIGINAL movement.',
  })
  @ApiConflictResponse({ description: 'Not enough points, or account inactive' })
  redeem(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: RedeemPointsDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<AppendMovementResult> {
    return this.loyalty.redeem(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('accounts/:id/adjust')
  @RequirePermissions('loyalty-points:adjust')
  @ApiOperation({
    summary: 'Append a manual adjustment, expiry, or reversal',
    description:
      'The ONLY way to correct a mistake: a new, signed movement. Nothing ' +
      'edits or removes an existing one.',
  })
  adjust(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: AdjustPointsDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<AppendMovementResult> {
    return this.loyalty.adjust(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  // ----------------------------------------------------------- promotions

  @Get('promotions')
  @RequirePermissions('promotion:read')
  @ApiOperation({ summary: 'List promotions and their versions' })
  listPromotions(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryPromotionsDto,
  ): Promise<{ items: PromotionDetail[]; total: number }> {
    return this.loyalty.findPromotions(tenantId, query);
  }

  @Post('promotions')
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'Create a promotion' })
  @ApiCreatedResponse({ description: 'Promotion created' })
  @ApiConflictResponse({ description: 'The code is already used' })
  createPromotion(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreatePromotionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Promotion> {
    return this.loyalty.createPromotion(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get('promotions/:id')
  @RequirePermissions('promotion:read')
  @ApiOperation({ summary: 'Read one promotion' })
  @ApiNotFoundResponse({ description: 'No such promotion in this tenant' })
  findPromotion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PromotionDetail> {
    return this.loyalty.findPromotionById(tenantId, id);
  }

  @Patch('promotions/:id')
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'Rename, re-prioritize, or archive a promotion' })
  updatePromotion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Promotion> {
    return this.loyalty.updatePromotion(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('promotions/:id/versions')
  @RequirePermissions('promotion:manage')
  @ApiOperation({
    summary: 'Create a DRAFT version of a promotion',
    description:
      'Changing a discount means creating a NEW version — an activated ' +
      'version is immutable, exactly as a price book version is.',
  })
  @ApiCreatedResponse({ description: 'Draft version created' })
  createVersion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CreatePromotionVersionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PromotionVersion> {
    return this.loyalty.createVersion(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get('promotions/:id/versions/:versionId')
  @RequirePermissions('promotion:read')
  @ApiOperation({ summary: 'Read one promotion version' })
  findVersion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<PromotionVersionSummary> {
    return this.loyalty.findVersion(tenantId, id, versionId);
  }

  @Get('promotions/:id/versions/:versionId/rules')
  @RequirePermissions('promotion:read')
  @ApiOperation({ summary: 'List the rules of one promotion version' })
  findRules(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<PromotionRuleWithProduct[]> {
    return this.loyalty.findRules(tenantId, id, versionId);
  }

  @Post('promotions/:id/versions/:versionId/rules')
  @RequirePermissions('promotion:manage')
  @ApiOperation({
    summary: 'Replace the rule set of a DRAFT version',
    description:
      'Whole-set semantics: a version is a complete snapshot of a ' +
      'promotion, so it activates, supersedes and rolls back as one unit.',
  })
  @ApiConflictResponse({ description: 'The version is not a DRAFT' })
  setRules(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: SetPromotionRulesDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PromotionVersion> {
    return this.loyalty.setRules(tenantId, id, versionId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('promotions/:id/versions/:versionId/activate')
  @RequirePermissions('promotion:activate')
  @ApiOperation({
    summary: 'Activate a promotion version',
    description:
      'The moment a discount starts applying to baskets. It supersedes the ' +
      'previously active version by CLOSING its window — no row is ' +
      'rewritten, and no price book is touched.',
  })
  @ApiConflictResponse({ description: 'The version cannot be activated' })
  activateVersion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: ActivatePromotionVersionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PromotionVersion> {
    return this.loyalty.activateVersion(tenantId, id, versionId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('promotions/:id/versions/:versionId/rollback')
  @RequirePermissions('promotion:activate')
  @ApiOperation({
    summary: 'Roll back to an earlier promotion version',
    description:
      'Copies that version’s rules into a NEW version and activates it, so ' +
      'history reads forward. The source version is never reopened.',
  })
  rollbackVersion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: RollbackPromotionVersionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PromotionVersion> {
    return this.loyalty.rollbackToVersion(tenantId, id, versionId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  // -------------------------------------------------------------- quoting

  @Get('quote')
  @RequirePermissions('promotion:read')
  @ApiOperation({
    summary: 'Explain what a product costs a shopper, and why',
    description:
      'Returns the base price WITH the price book version that produced it, ' +
      'and the promotion version (if any) that reduced it. Null when no ' +
      'price resolves — a product with no price is UNPRICED, never free, ' +
      'and a promotion cannot conjure a price for it.',
  })
  quote(
    @CurrentTenantId() tenantId: string,
    @Query() query: QuotePriceDto,
  ): Promise<PriceQuote | null> {
    return this.loyalty.quote(tenantId, query);
  }
}
