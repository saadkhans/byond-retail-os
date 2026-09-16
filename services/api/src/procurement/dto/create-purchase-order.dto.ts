import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

export class PurchaseOrderLineDto {
  @ApiProperty({ description: 'Product id in the caller tenant.' })
  @IsString()
  @MinLength(1)
  productId!: string;

  @ApiProperty({
    minimum: 1,
    maximum: 1000000,
    description: 'Packs ordered.',
  })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantityOrdered!: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100000,
    description:
      'Overrides the supplier catalog pack size for this order only. It is ' +
      'snapshotted onto the line, so a later catalog edit cannot ' +
      'reinterpret what was ordered.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  packSize?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Overrides the supplier catalog cost per pack, in minor units. Omit ' +
      'to use the catalog cost.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  unitCostMinor?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  supplierId!: string;

  @ApiProperty({
    description:
      'Destination location. Receiving writes the inventory ledger here.',
  })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({ description: 'ISO-4217 alphabetic currency code, e.g. AED.' })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currencyCode!: string;

  @ApiPropertyOptional({ description: 'Expected delivery date (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  expectedAt?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({ type: [PurchaseOrderLineDto], maxItems: 1000 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines!: PurchaseOrderLineDto[];
}
