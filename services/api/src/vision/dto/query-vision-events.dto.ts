import { ApiPropertyOptional } from '@nestjs/swagger';
import { VisionEventStatus, VisionEventType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class QueryVisionEventsDto {
  @ApiPropertyOptional({ enum: VisionEventStatus })
  @IsOptional()
  @IsEnum(VisionEventStatus)
  status?: VisionEventStatus;

  @ApiPropertyOptional({ enum: VisionEventType })
  @IsOptional()
  @IsEnum(VisionEventType)
  type?: VisionEventType;

  @ApiPropertyOptional({ description: 'Filter by checkout session id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  sessionId?: string;

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
