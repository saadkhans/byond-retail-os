import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class GoodsReceiptLineDto {
  @ApiProperty({ description: 'Purchase order line this delivery satisfies.' })
  @IsString()
  @MinLength(1)
  purchaseOrderLineId!: string;

  @ApiProperty({
    minimum: 0,
    maximum: 1000000,
    description:
      'Packs accepted. Zero is legal and means the line arrived empty: it ' +
      'records the fact without writing a ledger movement.',
  })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  quantityReceived!: number;

  @ApiPropertyOptional({
    enum: [
      'NONE',
      'SHORT_DELIVERY',
      'OVER_DELIVERY',
      'DAMAGED',
      'SUBSTITUTED',
    ],
    description:
      'What was wrong with this line. Omit it and the running totals decide ' +
      'between NONE, SHORT_DELIVERY and OVER_DELIVERY; an operator who ' +
      'states DAMAGED or SUBSTITUTED is never overruled by arithmetic.',
  })
  @IsOptional()
  @IsIn(['NONE', 'SHORT_DELIVERY', 'OVER_DELIVERY', 'DAMAGED', 'SUBSTITUTED'])
  discrepancy?:
    | 'NONE'
    | 'SHORT_DELIVERY'
    | 'OVER_DELIVERY'
    | 'DAMAGED'
    | 'SUBSTITUTED';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discrepancyNote?: string;
}

export class PostGoodsReceiptDto {
  @ApiPropertyOptional({
    maxLength: 80,
    description: 'The supplier delivery note number, as written on paper.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  deliveryNote?: string;

  @ApiPropertyOptional({ description: 'When the goods arrived (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description:
      'Tenant-scoped replay guard. Posting twice with the same key returns ' +
      'the receipt the first call created instead of stocking the delivery ' +
      'twice; reusing it for a different order is a conflict.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  idempotencyKey?: string;

  @ApiProperty({ type: [GoodsReceiptLineDto], maxItems: 1000 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptLineDto)
  lines!: GoodsReceiptLineDto[];
}
