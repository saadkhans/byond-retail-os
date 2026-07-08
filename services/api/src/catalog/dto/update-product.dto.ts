import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus, UnitOfMeasure } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

// SKU is intentionally NOT updatable: it identifies the product to external
// systems (barcode mappings, future POS/edge caches) and to the immutable
// inventory ledger's consumers. Barcodes are managed via the dedicated
// barcode sub-endpoints, not here.
export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Cola 330ml Can', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Category id (same tenant); null detaches.',
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  categoryId?: string | null;

  @ApiPropertyOptional({
    description: 'Brand id (same tenant); null detaches.',
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  brandId?: string | null;

  @ApiPropertyOptional({ enum: UnitOfMeasure })
  @IsOptional()
  @IsEnum(UnitOfMeasure)
  unitOfMeasure?: UnitOfMeasure;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ example: 12, nullable: true })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  lowStockThreshold?: number | null;
}
