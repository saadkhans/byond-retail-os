import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class QueryOrdersDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Filter by store (location) id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Filter by retail unit id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  unitId?: string;

  @ApiPropertyOptional({
    description: 'Exact order number (case-insensitive), e.g. ORD-000001.',
    maxLength: 30,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  orderNumber?: string;

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
