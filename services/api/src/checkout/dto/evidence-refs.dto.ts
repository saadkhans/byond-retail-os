import { ApiPropertyOptional } from '@nestjs/swagger';
import { EvidenceQuality, EvidenceSourceType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Vendor-neutral evidence/source lineage inputs shared by checkout session
 * and basket line mutations. These are normalized REFERENCES only — opaque
 * identifiers a future CV/VLM adapter layer will resolve. Phase 5 stores and
 * returns them verbatim; it never interprets them, and nothing in the core
 * depends on any specific vision provider, model, or camera SDK.
 *
 * Because they are persisted verbatim, every string field here (and every
 * reasonCodes entry) is additionally screened for credential- or
 * payment-bearing content (raw PANs, tokens, credential URLs, CVV/PIN
 * fragments) by `assertSafeEvidenceRefs` in CheckoutSessionsService before
 * any write — same shared detection (common/sensitive-keys) and same
 * controlled-400 pattern as device metadata. Payment data and secrets must
 * never reach storage (AGENTS.md payments invariant).
 */
export class EvidenceRefsDto {
  @ApiPropertyOptional({
    enum: EvidenceSourceType,
    default: EvidenceSourceType.MANUAL,
    description:
      'What produced this mutation: a manual/admin action today, a vision ' +
      'or device event once the CV/VLM adapter phases ship.',
  })
  @IsOptionalNonNull()
  @IsEnum(EvidenceSourceType)
  sourceType?: EvidenceSourceType;

  @ApiPropertyOptional({
    description:
      'Opaque id of the producing source (e.g. a device or adapter id).',
    maxLength: 200,
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceId?: string;

  @ApiPropertyOptional({
    description: 'Opaque reference to a future evidence bundle.',
    maxLength: 200,
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  evidenceBundleId?: string;

  @ApiPropertyOptional({
    description: 'Opaque reference to a future normalized vision event.',
    maxLength: 200,
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  visionEventId?: string;

  @ApiPropertyOptional({
    description: 'Opaque reference to a future VLM review.',
    maxLength: 200,
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  vlmReviewId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: 'Normalized confidence score reported by the source.',
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  evidenceScore?: number;

  @ApiPropertyOptional({ enum: EvidenceQuality })
  @IsOptionalNonNull()
  @IsEnum(EvidenceQuality)
  evidenceQuality?: EvidenceQuality;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    description:
      'Normalized reason codes attached by the source (occlusion, ' +
      'low-confidence, manual-correction, ...). Free-form, vendor-neutral.',
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  reasonCodes?: string[];
}
