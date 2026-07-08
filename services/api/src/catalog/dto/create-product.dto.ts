import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BarcodeFormat, ProductStatus, UnitOfMeasure } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';

export class ProductBarcodeInputDto {
  @ApiProperty({ example: '4006381333931', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^\S+$/, { message: 'barcode value must not contain whitespace' })
  value!: string;

  @ApiPropertyOptional({ enum: BarcodeFormat, default: BarcodeFormat.OTHER })
  @IsOptional()
  @IsEnum(BarcodeFormat)
  format?: BarcodeFormat;
}

export class CreateProductDto {
  @ApiProperty({
    example: 'BEV-COLA-330',
    description: 'Stock-keeping unit, unique per tenant (case-insensitive).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'sku must contain only letters, digits, dots, underscores, and hyphens',
  })
  sku!: string;

  @ApiProperty({ example: 'Cola 330ml Can', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Category id (same tenant).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Brand id (same tenant).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  brandId?: string;

  // Non-nullable enum columns: reject an explicit null (which @IsOptional
  // would wave through into a Prisma/DB error) while still allowing the field
  // to be omitted so the schema default applies.
  @ApiPropertyOptional({
    enum: UnitOfMeasure,
    default: UnitOfMeasure.EACH,
    description:
      'Stock quantities are integers in this unit. Weight/volume products ' +
      'use GRAM/MILLILITER so counts stay integral.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(UnitOfMeasure)
  unitOfMeasure?: UnitOfMeasure;

  @ApiPropertyOptional({ enum: ProductStatus, default: ProductStatus.DRAFT })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({
    example: 12,
    description:
      'Inventory reads flag stock at or below this quantity as low stock.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PG_INT_MAX)
  lowStockThreshold?: number;

  @ApiPropertyOptional({
    type: [ProductBarcodeInputDto],
    description: 'Barcodes resolving to this product (unique per tenant).',
  })
  @IsOptional()
  @ValidateNested({ each: true })
  @ArrayMaxSize(20)
  @Type(() => ProductBarcodeInputDto)
  barcodes?: ProductBarcodeInputDto[];
}
