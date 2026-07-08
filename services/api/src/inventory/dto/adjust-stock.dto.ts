import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

// Inventory quantities are persisted as Postgres INTEGER; a delta outside this
// range would pass @IsInt() only to fail at the database with an unhandled
// range error. Bound it at the validation layer instead.
const PG_INT_MIN = -2_147_483_648;
const PG_INT_MAX = 2_147_483_647;

// tenantId is intentionally absent: it comes exclusively from the
// authenticated request context, and the global whitelist ValidationPipe
// (forbidNonWhitelisted) rejects any attempt to smuggle one in the body.
export class AdjustStockDto {
  @ApiProperty({ description: 'Location id (must belong to the caller’s tenant).' })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({ description: 'Product id (must belong to the caller’s tenant).' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({
    example: -3,
    description:
      'Signed integer stock change in the product’s unit of measure. ' +
      'Never zero; the resulting on-hand quantity must stay >= 0.',
  })
  @IsInt()
  @Min(PG_INT_MIN)
  @Max(PG_INT_MAX)
  @NotEquals(0)
  quantityDelta!: number;

  @ApiProperty({
    example: 'Cycle count correction — damaged cans',
    description: 'Human-readable justification, recorded immutably.',
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
