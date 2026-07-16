import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentCaptureStatus } from '@prisma/client';
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

export class QueryCapturesDto {
  @ApiPropertyOptional({ enum: PaymentCaptureStatus })
  @IsOptional()
  @IsEnum(PaymentCaptureStatus)
  status?: PaymentCaptureStatus;

  @ApiPropertyOptional({ description: 'Filter by payment intent id.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  intentId?: string;

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
