import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreatePromotionDto {
  @ApiProperty({
    maxLength: 40,
    description:
      'Short code, unique per tenant and normalized to uppercase ' +
      '(SUMMER-10, MEMBER-COFFEE).',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  code!: string;

  @ApiProperty({
    maxLength: 120,
    description:
      'Operator-facing name. Screened free text — a credential- or ' +
      'payment-bearing value is rejected, not stored.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    enum: ['ALL_SHOPPERS', 'LOYALTY_MEMBERS'],
    default: 'ALL_SHOPPERS',
    description:
      'LOYALTY_MEMBERS applies only when the basket carries an ACTIVE ' +
      'loyalty account.',
  })
  @IsOptional()
  @IsIn(['ALL_SHOPPERS', 'LOYALTY_MEMBERS'])
  audience?: 'ALL_SHOPPERS' | 'LOYALTY_MEMBERS';

  @ApiPropertyOptional({
    description:
      'Store (location) id in the caller’s tenant. Omit for a tenant-wide ' +
      'promotion; a location-scoped one wins at its own location.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({
    default: 0,
    minimum: -1000,
    maximum: 1000,
    description:
      'Tie-break only, higher first. It can never make a SMALLER discount ' +
      'beat a larger one — the largest discount always wins.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;
}

export class UpdatePromotionDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'ARCHIVED'],
    description:
      'ARCHIVING is how a promotion is withdrawn: its versions stop ' +
      'applying immediately, and nothing in its history is edited.',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ minimum: -1000, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;
}

export class QueryPromotionsDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ enum: ['ALL_SHOPPERS', 'LOYALTY_MEMBERS'] })
  @IsOptional()
  @IsIn(['ALL_SHOPPERS', 'LOYALTY_MEMBERS'])
  audience?: 'ALL_SHOPPERS' | 'LOYALTY_MEMBERS';

  @ApiPropertyOptional({ description: 'Filter by location id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

export class CreatePromotionVersionDto {
  @ApiPropertyOptional({
    enum: ['INITIAL', 'RULE_CHANGE', 'CORRECTION', 'ROLLBACK'],
    default: 'RULE_CHANGE',
  })
  @IsOptional()
  @IsIn(['INITIAL', 'RULE_CHANGE', 'CORRECTION', 'ROLLBACK'])
  reason?: 'INITIAL' | 'RULE_CHANGE' | 'CORRECTION' | 'ROLLBACK';

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Why this version exists. Screened free text; also copied into ' +
      'AuditLog.reason.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: 'Intended start instant (ISO-8601). Defaults to now.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    description:
      'Seed the draft with the rules of an existing version of the SAME ' +
      'promotion. The source is read-only — it is never edited or reopened.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  copyFromVersionId?: string;
}

export class PromotionRuleDto {
  @ApiPropertyOptional({
    description:
      'Product id in the caller’s tenant. Omit for the catalog-wide rule, ' +
      'which applies to every product the base price covers. A ' +
      'product-specific rule beats it.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  productId?: string;

  @ApiProperty({
    enum: ['PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_UNIT_PRICE'],
    description:
      'All three are strictly SUBTRACTIVE: a promotion can only ever lower ' +
      'the price the price version resolved, never raise it.',
  })
  @IsIn(['PERCENT_OFF', 'AMOUNT_OFF', 'FIXED_UNIT_PRICE'])
  kind!: 'PERCENT_OFF' | 'AMOUNT_OFF' | 'FIXED_UNIT_PRICE';

  @ApiProperty({
    minimum: 1,
    maximum: 100_000_000,
    description:
      'PERCENT_OFF: basis points (1..10000 = 0.01%..100%). AMOUNT_OFF: ' +
      'minor units off. FIXED_UNIT_PRICE: the promoted unit price in minor ' +
      'units, ignored when it is not BELOW the base price.',
  })
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  value!: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100_000_000,
    description: 'Ceiling in minor units, for PERCENT_OFF. Omit for uncapped.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  maxDiscountMinor?: number;
}

/**
 * Replaces the whole rule set of a DRAFT version. Whole-set semantics are
 * deliberate, exactly as for price entries: a version is a complete,
 * self-describing snapshot of a promotion, so it can be activated,
 * superseded and rolled back as one unit.
 */
export class SetPromotionRulesDto {
  @ApiProperty({ type: [PromotionRuleDto], maxItems: 5000 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => PromotionRuleDto)
  rules!: PromotionRuleDto[];
}

export class ActivatePromotionVersionDto {
  @ApiPropertyOptional({
    description:
      'Instant the version starts applying (ISO-8601). Defaults to now. It ' +
      'must be strictly after the currently active version’s start, so ' +
      'windows move forward and never overlap.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class RollbackPromotionVersionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

/**
 * The explainability endpoint: what does this product cost this shopper, and
 * WHICH price version and WHICH promotion version produced that number.
 */
export class QuotePriceDto {
  @ApiProperty({ description: 'Product id in the caller’s tenant.' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiPropertyOptional({
    description:
      'Instant to quote at (ISO-8601). Defaults to now. A past instant ' +
      'answers historically — superseded price AND promotion versions keep ' +
      'their closed windows.',
  })
  @IsOptional()
  @IsISO8601()
  at?: string;

  @ApiPropertyOptional({ description: 'Store (location) id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({
    description:
      'Loyalty account id, to include member-only promotions. A suspended ' +
      'or closed account counts as no member.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  loyaltyAccountId?: string;
}
