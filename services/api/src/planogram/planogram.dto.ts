import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class PlanogramCellDto {
  @IsInt()
  @Min(0)
  @Max(25)
  rowIndex!: number;

  @IsInt()
  @Min(0)
  @Max(98)
  columnIndex!: number;

  @IsString()
  @Length(1, 64)
  productId!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  facingCount?: number;
}

export class PublishPlanogramRackDto {
  @IsString()
  @Length(1, 64)
  locationId!: string;

  @IsString()
  @Length(1, 32)
  rackCode!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsInt()
  @Min(1)
  @Max(26)
  rows!: number;

  @IsInt()
  @Min(1)
  @Max(99)
  columns!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PlanogramCellDto)
  cells!: PlanogramCellDto[];
}
