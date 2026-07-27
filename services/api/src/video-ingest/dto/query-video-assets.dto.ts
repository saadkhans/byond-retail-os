import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoAssetStatus } from '@prisma/client';
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

export class QueryVideoAssetsDto {
  @ApiPropertyOptional({ enum: VideoAssetStatus })
  @IsOptional()
  @IsEnum(VideoAssetStatus)
  status?: VideoAssetStatus;

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
