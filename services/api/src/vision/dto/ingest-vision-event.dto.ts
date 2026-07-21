import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EvidenceQuality,
  EvidenceSourceType,
  VisionEventType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { IsOptionalNonNull } from '../../common/validation';
import {
  MAX_REASON_CODES,
  MAX_REASON_CODE_LENGTH,
  REASON_CODE_PATTERN,
  REASON_CODE_REGEX,
} from '../evidence-contract';

const REASON_CODE_MESSAGE =
  'must be a lowercase slug reason code: letter/digit segments joined ' +
  'by ".", "_" or "-"';

/**
 * The published evidence-bundle schema is CLOSED (`additionalProperties:
 * false`, explicit lineage properties only): Phase 7 accepts NO evidence
 * payload fields — no artifacts, no metadata, no provenance strings, no
 * media descriptors of any kind. Generated clients cannot produce a
 * shape the API would 400.
 */
const EVIDENCE_BUNDLE_LINEAGE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    sourceType: {
      type: 'string' as const,
      enum: Object.values(EvidenceSourceType),
      description: 'Producing source category (closed enum).',
    },
    captureStartedAt: {
      type: 'string' as const,
      format: 'date-time',
      description: 'Capture window start reported by the source (ISO 8601).',
    },
    captureEndedAt: {
      type: 'string' as const,
      format: 'date-time',
      description: 'Capture window end reported by the source (ISO 8601).',
    },
  },
};

/**
 * One ranked SKU candidate proposed by the source. Candidates reference the
 * tenant's catalog by SKU — the vendor-neutral contract is that adapters
 * NORMALIZE their raw detections to catalog SKUs before ingesting; an
 * unknown SKU rejects the whole event with a controlled 400 naming it.
 */
export class VisionEventCandidateDto {
  @ApiProperty({
    description:
      'Tenant catalog SKU (case-insensitive; normalized to uppercase).',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 1000,
    description:
      'Explicit rank (1 = strongest). When omitted, candidates are ranked ' +
      'by their array order. Mixing explicit and implicit ranks is rejected.',
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  rank?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: 'Normalized confidence for THIS candidate.',
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  score?: number;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Opaque label the source used for the detected object (never ' +
      'interpreted; stored verbatim for review context).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;
}

/**
 * Inline evidence bundle creation — a LIGHTWEIGHT LINEAGE RECORD only.
 * Phase 7 MVP accepts no evidence payloads: no artifact descriptors, no
 * metadata objects, no provenance strings, no media references. The
 * bundle exists so events, reviews, and basket lines can point at an
 * append-only lineage row; external media references arrive in the
 * future evidence storage phase.
 */
export class EvidenceBundleInputDto {
  @ApiPropertyOptional({
    enum: EvidenceSourceType,
    default: EvidenceSourceType.VISION,
  })
  @IsOptionalNonNull()
  @IsEnum(EvidenceSourceType)
  sourceType?: EvidenceSourceType;

  @ApiPropertyOptional({
    description: 'Capture window start reported by the source (ISO 8601).',
  })
  @IsOptionalNonNull()
  @IsDateString()
  captureStartedAt?: string;

  @ApiPropertyOptional({
    description: 'Capture window end reported by the source (ISO 8601).',
  })
  @IsOptionalNonNull()
  @IsDateString()
  captureEndedAt?: string;
}

/**
 * Normalized product interaction event ingestion. Provider-neutral: no
 * camera SDK, detector, or (V)LM specifics — adapters normalize upstream
 * and submit typed fields only (evidence payloads and provenance strings
 * are out of scope for Phase 7 MVP). Ingestion NEVER mutates the basket
 * or inventory; only an approved review decision does.
 */
export class IngestVisionEventDto {
  @ApiProperty({ description: 'Store (location) the event happened in.' })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({
    description: 'Retail unit the event happened at (must be in the store).',
  })
  @IsString()
  @MinLength(1)
  unitId!: string;

  @ApiPropertyOptional({
    description:
      'Source camera/device (must be attached to the unit). Optional — no ' +
      'edge runtime in this phase.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  deviceId?: string;

  @ApiPropertyOptional({
    description:
      'Checkout session to bind the event to (must be on the same unit). ' +
      'Basket-affecting approvals require a bound session; an event ' +
      'ingested before the session is known can be bound later via ' +
      'POST /vision-events/:id/session.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  sessionId?: string;

  @ApiProperty({ enum: VisionEventType })
  @IsEnum(VisionEventType)
  type!: VisionEventType;

  @ApiProperty({
    description: 'When the interaction happened per the source (ISO 8601).',
  })
  @IsDateString()
  occurredAt!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PG_INT_MAX,
    default: 1,
    description:
      'Units the source believes were moved (integer, in the product’s ' +
      'unit of measure).',
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PG_INT_MAX)
  quantity?: number;

  @ApiPropertyOptional({
    type: [VisionEventCandidateDto],
    maxItems: 20,
    description:
      'Ranked SKU candidates (1 = strongest). May be empty for event types ' +
      'that carry no product proposal (e.g. EXIT_RECONCILIATION); approving ' +
      'a basket-affecting event requires at least one candidate.',
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VisionEventCandidateDto)
  candidates?: VisionEventCandidateDto[];

  @ApiPropertyOptional({
    enum: EvidenceSourceType,
    default: EvidenceSourceType.VISION,
  })
  @IsOptionalNonNull()
  @IsEnum(EvidenceSourceType)
  sourceType?: EvidenceSourceType;

  @ApiPropertyOptional({
    description:
      'Existing evidence bundle to attach. Mutually exclusive with the ' +
      'inline `evidenceBundle` object.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  evidenceBundleId?: string;

  @ApiPropertyOptional({
    ...EVIDENCE_BUNDLE_LINEAGE_SCHEMA,
    description:
      'Inline evidence bundle created atomically with the event — a ' +
      'CLOSED lineage-only record (sourceType, captureStartedAt, ' +
      'captureEndedAt). Evidence payload fields (artifacts, metadata, ' +
      'URIs, storage keys, provenance strings, inline media) are out of ' +
      'scope for Phase 7 MVP and rejected. Mutually exclusive with ' +
      '`evidenceBundleId`.',
  })
  @IsOptionalNonNull()
  @ValidateNested()
  @Type(() => EvidenceBundleInputDto)
  evidenceBundle?: EvidenceBundleInputDto;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: 'Normalized overall confidence reported by the source.',
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
    type: 'array',
    items: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_REASON_CODE_LENGTH,
      pattern: REASON_CODE_PATTERN,
    },
    maxItems: MAX_REASON_CODES,
    description:
      'Normalized reason codes attached by the source (occlusion, ' +
      'low-confidence, multi-hand, ...). Lowercase slug strings only, ' +
      'vendor-neutral.',
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayMaxSize(MAX_REASON_CODES)
  @IsString({ each: true })
  @MaxLength(MAX_REASON_CODE_LENGTH, { each: true })
  @Matches(REASON_CODE_REGEX, {
    each: true,
    message: `each reason code ${REASON_CODE_MESSAGE}`,
  })
  reasonCodes?: string[];

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key: at-least-once delivery replays the ' +
      'original event instead of duplicating it.',
  })
  // Persisted verbatim → screened by the service (no credential- or
  // payment-bearing values), like evidence refs.
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
