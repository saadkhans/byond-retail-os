import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LocationType } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateLocationDto {
  @ApiProperty({ example: 'Downtown Flagship', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    example: 'DT-001',
    description: 'Short human-readable code, unique per tenant.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'code must contain only letters, digits, and hyphens',
  })
  code!: string;

  @ApiProperty({ enum: LocationType, example: LocationType.STORE })
  @IsEnum(LocationType)
  type!: LocationType;

  @ApiPropertyOptional({ example: 'Europe/Berlin', default: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Free-form address object.' })
  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;
}
