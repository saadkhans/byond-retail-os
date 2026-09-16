import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  JourneyEventReviewDecision,
  StoreFlowAutonomyLevel,
} from '@prisma/client';
import {
  ENTRY_TOKEN_DEFAULT_TTL_SECONDS,
  ENTRY_TOKEN_MAX_TTL_SECONDS,
  ENTRY_TOKEN_MIN_TTL_SECONDS,
  STORE_FLOW_QUEUE_MAX_ITEMS,
} from './store-flow.constants';

/** Phase 26 — request bodies for the store flow. */

export class PublishStoreFlowPolicyDto {
  @ApiPropertyOptional({
    description:
      'Store this policy governs. Omit for the tenant-wide default, which ' +
      'applies at every store without one of its own.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  locationId?: string;

  @ApiProperty({
    enum: StoreFlowAutonomyLevel,
    description:
      'SHADOW observes and changes nothing. PROPOSE turns observations into ' +
      'pending vision events for a human. AUTO_APPLY additionally applies ' +
      'confident, inventory-validated observations without one.',
  })
  @IsEnum(StoreFlowAutonomyLevel)
  autonomyLevel!: StoreFlowAutonomyLevel;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description:
      'Minimum fused score an observation must carry before AUTO_APPLY may ' +
      'apply it unattended. An uncalibrated ranking score, not a probability.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  autoApplyMinConfidence?: number;

  @ApiPropertyOptional({
    description:
      'Check the proposal against the store inventory projection before ' +
      'applying it unattended. Defaults to true and should stay true.',
  })
  @IsOptional()
  @IsBoolean()
  requireInventoryValidation?: boolean;

  @ApiPropertyOptional({
    description:
      'Complete the checkout session into an order and settle it when the ' +
      'shopper exits.',
  })
  @IsOptional()
  @IsBoolean()
  settleOnExit?: boolean;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Why the policy changed. Screened before it is persisted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class IssueEntryTokenDto {
  @ApiProperty({ description: 'Store the shopper is entering.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  locationId!: string;

  @ApiProperty({
    description: 'Retail unit within the store (must belong to it).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  unitId!: string;

  @ApiPropertyOptional({
    description:
      'Existing shopper to bind the credential to. Omit and redemption ' +
      'creates an anonymous shopper.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  shopperId?: string;

  @ApiPropertyOptional({
    minimum: ENTRY_TOKEN_MIN_TTL_SECONDS,
    maximum: ENTRY_TOKEN_MAX_TTL_SECONDS,
    default: ENTRY_TOKEN_DEFAULT_TTL_SECONDS,
    description:
      'How long the credential stays usable. Entry credentials are ' +
      'single-use and short-TTL by requirement; the ceiling is enforced.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ENTRY_TOKEN_MIN_TTL_SECONDS)
  @Max(ENTRY_TOKEN_MAX_TTL_SECONDS)
  ttlSeconds?: number;
}

export class RedeemEntryTokenDto {
  @ApiProperty({
    description:
      'The secret handed out at issuance. It is matched by digest and burned ' +
      'on first use.',
    maxLength: 200,
  })
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'token must be a base64url string',
  })
  token!: string;
}

export class ReviewObservationDto {
  @ApiProperty({
    enum: JourneyEventReviewDecision,
    description:
      'One decision, recorded against the journey observation AND applied to ' +
      'the vision event it produced.',
  })
  @IsEnum(JourneyEventReviewDecision)
  decision!: JourneyEventReviewDecision;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Reviewer note. Screened before it is persisted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description: 'CORRECT only: the product the reviewer says it really was.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  correctedProductId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    description: 'CORRECT only: the quantity the reviewer says it really was.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  correctedQuantity?: number;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Replay token. A retried decision returns the original outcome instead ' +
      'of recording a second human action.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}

export class StoreFlowQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: STORE_FLOW_QUEUE_MAX_ITEMS,
    default: STORE_FLOW_QUEUE_MAX_ITEMS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(STORE_FLOW_QUEUE_MAX_ITEMS)
  limit?: number;
}
