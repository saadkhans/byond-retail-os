import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CvDatasetImprovementRunStatus,
  CvDatasetPurpose,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';

/** Phase 18 — dataset improvement DTOs. Whitelisted fields only. */

export class CreateDatasetRunDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ enum: CvDatasetPurpose })
  @IsEnum(CvDatasetPurpose)
  purpose!: CvDatasetPurpose;

  @ApiPropertyOptional({ description: 'Phase 15 evaluation run id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  sourceEvaluationRunId?: string;

  @ApiPropertyOptional({ description: 'Phase 16 test protocol id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  sourceTestProtocolId?: string;

  @ApiPropertyOptional({
    description: 'Phase 17 calibration profile id, tenant-scoped',
  })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  sourceCalibrationProfileId?: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(100)
  trainSplitPercent!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(100)
  validationSplitPercent!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(100)
  testSplitPercent!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 5 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(100)
  minReviewedExamplesPerSku?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 5 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(100)
  minReviewedExamplesPerAction?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

export class UpdateDatasetRunDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ enum: CvDatasetPurpose })
  @IsOptionalNonNull()
  @IsEnum(CvDatasetPurpose)
  purpose?: CvDatasetPurpose;

  @ApiPropertyOptional({ description: 'Phase 15 evaluation run id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  sourceEvaluationRunId?: string;

  @ApiPropertyOptional({ description: 'Phase 16 test protocol id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  sourceTestProtocolId?: string;

  @ApiPropertyOptional({
    description: 'Phase 17 calibration profile id, tenant-scoped',
  })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  sourceCalibrationProfileId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(100)
  trainSplitPercent?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(100)
  validationSplitPercent?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(0)
  @Max(100)
  testSplitPercent?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(100)
  minReviewedExamplesPerSku?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(100)
  minReviewedExamplesPerAction?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

export class SetDatasetRunStatusDto {
  @ApiProperty({ enum: ['READY', 'ARCHIVED'] })
  @IsIn([
    CvDatasetImprovementRunStatus.READY,
    CvDatasetImprovementRunStatus.ARCHIVED,
  ])
  status!: CvDatasetImprovementRunStatus;
}
