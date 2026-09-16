import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Sets what a supplier charges for one product. Re-sending it with a different
 * cost appends a history row rather than overwriting the old figure, so a
 * purchase cost is as auditable as a retail price.
 */
export class UpsertSupplierProductDto {
  @ApiProperty({ description: 'Product id in the caller tenant.' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({
    maxLength: 80,
    description: 'The supplier own identifier for this product.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  supplierSku!: string;

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    maximum: 100000,
    description:
      'Units of OUR product per supplier pack. Receiving 3 packs of 12 ' +
      'admits 36 units to the ledger.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  packSize?: number;

  @ApiProperty({
    minimum: 0,
    description: 'Cost of ONE PACK in minor currency units (1099 = 10.99).',
  })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  unitCostMinor!: number;

  @ApiProperty({ description: 'ISO-4217 alphabetic currency code, e.g. AED.' })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currencyCode!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  leadTimeDays?: number;

  @ApiPropertyOptional({
    description: 'Marks this supplier as the default source for the product.',
  })
  @IsOptional()
  @IsBoolean()
  isPreferred?: boolean;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Why the cost changed. Stored on the appended history row and copied ' +
      'into the audit log, so it is screened for sensitive values.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
