import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderReturnKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsOptionalNonNull } from '../common/validation';
import { MAX_RETURN_LINES } from './returns.constants';

/**
 * Phase 27 transport contracts.
 *
 * Two conventions run through all of them:
 *
 *   * Every free-text field (reason, note) is length-bounded here and
 *     credential-screened in the service before any write. These strings are
 *     persisted verbatim AND copied into AuditLog.reason, which audit
 *     redaction does not cover.
 *   * Every mutating request carries a caller-supplied `reference`, which is
 *     the tenant-scoped idempotency key. Charset is deliberately narrow so a
 *     reference cannot smuggle prose (or a PAN) into the ledger.
 */

const REFERENCE_PATTERN = /^[A-Za-z0-9._-]+$/;

export class ReturnLineDto {
  @ApiProperty({ description: 'The order line these goods came from.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  orderLineId!: string;

  @ApiProperty({ minimum: 1, description: 'Units coming back.' })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether the goods went back on the shelf. False for damaged or ' +
      'unsellable stock: no RETURN_IN movement is written, which is the ' +
      'honest record that stock did not change.',
  })
  @IsOptionalNonNull()
  @IsBoolean()
  restock?: boolean;

  @ApiPropertyOptional({ maxLength: 500, description: 'Condition note.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class RecordReturnDto {
  @ApiProperty({ description: 'The order the goods came from.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  orderId!: string;

  @ApiProperty({
    enum: OrderReturnKind,
    description:
      'CUSTOMER_RETURN takes the named lines back. ORDER_CANCELLATION ' +
      'reverses everything still outstanding and cancels the order.',
  })
  @IsEnum(OrderReturnKind)
  kind!: OrderReturnKind;

  @ApiProperty({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency reference. Replaying a return with the same ' +
      'reference returns the original return instead of reversing stock or ' +
      'refunding money twice.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(REFERENCE_PATTERN, {
    message: 'reference may contain only letters, digits, dot, underscore and hyphen',
  })
  reference!: string;

  @ApiProperty({ maxLength: 500, description: 'Why the goods came back.' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: [ReturnLineDto],
    description:
      'Required for CUSTOMER_RETURN. Omitted for ORDER_CANCELLATION, which ' +
      'always reverses every line that has not already come back.',
  })
  @IsOptionalNonNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  lines?: ReturnLineDto[];

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether to refund the money the returned lines are worth. False ' +
      'records a stock-only return. A refund is only ever attempted against a ' +
      'CAPTURED payment; there is no way to refund money that was never taken.',
  })
  @IsOptionalNonNull()
  @IsBoolean()
  refund?: boolean;
}

export class QueryReturnsDto {
  @ApiPropertyOptional({ description: 'Filter to one order.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  orderId?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

// ---------------------------------------------------------------------------
// Cycle counts
// ---------------------------------------------------------------------------

export class OpenCycleCountDto {
  @ApiProperty({ description: 'The store being counted.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  locationId!: string;

  @ApiProperty({
    maxLength: 100,
    description: 'Tenant-scoped reference for this count (also idempotency).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(REFERENCE_PATTERN, {
    message: 'reference may contain only letters, digits, dot, underscore and hyphen',
  })
  reference!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'True for a full stocktake of the location, false for a sample cycle ' +
      'count. Recorded for the audit trail; it changes no arithmetic.',
  })
  @IsOptionalNonNull()
  @IsBoolean()
  isFullStocktake?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class RecordCountLineDto {
  @ApiProperty({ description: 'The product that was counted.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productId!: string;

  @ApiProperty({
    minimum: 0,
    description: 'How many units the operator actually found on the shelf.',
  })
  @IsInt()
  @Min(0)
  countedQuantity!: number;

  @ApiPropertyOptional({ maxLength: 500, description: 'Discrepancy note.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class QueryCycleCountsDto {
  @ApiPropertyOptional({ description: 'Filter to one store.' })
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

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class CancelCycleCountDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Why it was abandoned.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}

// ---------------------------------------------------------------------------
// Shrink
// ---------------------------------------------------------------------------

export class RecordShrinkDto {
  @ApiProperty({
    description:
      'The vision observation that detected the loss. The write-off is ' +
      'idempotent per observation: one observation can be written off once.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  visionEventId!: string;

  @ApiProperty({
    description:
      'Which product was lost. Must be one of the candidates the observation ' +
      'actually proposed — a write-off cannot name an unrelated SKU.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productId!: string;

  @ApiProperty({ minimum: 1, description: 'Units written off.' })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ maxLength: 500, description: 'Why this counts as loss.' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class QueryShrinkDto {
  @ApiPropertyOptional({ description: 'Filter to one store.' })
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

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
