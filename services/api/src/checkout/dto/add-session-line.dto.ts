import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { IsOptionalNonNull } from '../../common/validation';
import { EvidenceRefsDto } from './evidence-refs.dto';

export class AddSessionLineDto extends EvidenceRefsDto {
  @ApiProperty({
    description:
      'Tenant product to add. Must be ACTIVE (saleable); the line snapshots ' +
      'its SKU, name, and unit of measure at add time.',
  })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({ minimum: 1, maximum: PG_INT_MAX })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PG_INT_MAX)
  quantity!: number;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key: retrying the same add returns the ' +
      'original line instead of failing on the one-line-per-product rule.',
  })
  // Persisted verbatim → screened by assertSafeIdempotencyKey in the
  // service (no credential- or payment-bearing values), like evidence refs.
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
