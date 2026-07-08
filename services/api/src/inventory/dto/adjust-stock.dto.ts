import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  MaxLength,
  MinLength,
  NotEquals,
} from 'class-validator';

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
