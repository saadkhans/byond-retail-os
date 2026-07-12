import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RetailUnitStatus, RetailUnitType } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({
    description: 'The store (location) this unit is assigned to.',
  })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({
    example: 'FRIDGE-001',
    description: 'Short human-readable code, unique per tenant.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'code must contain only letters, digits, and hyphens',
  })
  code!: string;

  @ApiProperty({ example: 'Entrance Smart Fridge', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: RetailUnitType, example: RetailUnitType.SMART_FRIDGE })
  @IsEnum(RetailUnitType)
  type!: RetailUnitType;

  @ApiPropertyOptional({
    enum: [RetailUnitStatus.DRAFT, RetailUnitStatus.ACTIVE],
    default: RetailUnitStatus.DRAFT,
    description:
      'Initial status: DRAFT or ACTIVE only. Later states are reached ' +
      'through lifecycle transitions on update.',
  })
  @IsOptional()
  @IsEnum(RetailUnitStatus)
  status?: RetailUnitStatus;

  @ApiPropertyOptional({
    example: 'Aisle 3, next to the entrance',
    description: 'Physical placement within the store.',
    maxLength: 240,
  })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  placement?: string;
}
