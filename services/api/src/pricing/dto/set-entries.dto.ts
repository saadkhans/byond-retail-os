import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PriceEntryDto {
  @ApiProperty({ description: 'Product id in the caller’s tenant.' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({
    minimum: 0,
    description:
      'Price in MINOR currency units (1099 = 10.99). Integer-exact — there ' +
      'is no floating point anywhere in the money path.',
  })
  @IsInt()
  @Min(0)
  // Well inside PostgreSQL INTEGER; a single unit priced above this is a
  // data-entry error, not a real price.
  @Max(100_000_000)
  unitPriceMinor!: number;
}

/**
 * Replaces the whole entry set of a DRAFT version. Whole-set semantics are
 * deliberate: a version is a complete, self-describing snapshot of a book's
 * prices, so it can be activated, superseded and rolled back as one unit.
 */
export class SetEntriesDto {
  @ApiProperty({ type: [PriceEntryDto], maxItems: 5000 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => PriceEntryDto)
  entries!: PriceEntryDto[];
}
