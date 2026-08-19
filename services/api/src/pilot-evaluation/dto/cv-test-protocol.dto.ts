import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CvTestProtocolStatus,
  CvTestScenarioResult,
  CvTestScenarioType,
  PilotExpectedAction,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  IsOptionalNonNull,
  toNumberRejectingBlank,
} from '../../common/validation';

/** Phase 16 — CV test protocol DTOs. Whitelisted fields only. */

export class CreateTestProtocolDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 300)
  description?: string;

  @ApiPropertyOptional({ description: 'Store (location) id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Camera source id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  cameraSourceId?: string;

  @ApiPropertyOptional({ description: 'Evaluation run id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  evaluationRunId?: string;

  @ApiPropertyOptional({
    description: 'Whether the protocol expects fast mode (null = no expectation)',
  })
  @IsOptionalNonNull()
  @IsBoolean()
  fastModeExpected?: boolean;
}

export class SetTestProtocolStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'] })
  @IsIn([
    CvTestProtocolStatus.ACTIVE,
    CvTestProtocolStatus.COMPLETED,
    CvTestProtocolStatus.CANCELLED,
  ])
  status!: CvTestProtocolStatus;
}

export class LinkEvaluationRunDto {
  @ApiProperty({ description: 'Evaluation run id, tenant-scoped' })
  @IsString()
  @Length(1, 64)
  evaluationRunId!: string;
}

export class AddTestScenarioDto {
  @ApiProperty({ enum: CvTestScenarioType })
  @IsEnum(CvTestScenarioType)
  scenarioType!: CvTestScenarioType;

  @ApiProperty({ enum: PilotExpectedAction })
  @IsEnum(PilotExpectedAction)
  expectedAction!: PilotExpectedAction;

  @ApiPropertyOptional({ description: 'Expected product id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  expectedProductId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 99 })
  @IsOptionalNonNull()
  @Transform(toNumberRejectingBlank)
  @IsInt()
  @Min(1)
  @Max(99)
  expectedQuantity?: number;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 300)
  notes?: string;
}

export class RecordScenarioResultDto {
  @ApiProperty({ enum: CvTestScenarioResult })
  @IsEnum(CvTestScenarioResult)
  result!: CvTestScenarioResult;

  @ApiProperty({
    description:
      'The evaluated live session — REQUIRED and must be attached to the ' +
      "protocol's linked evaluation run",
  })
  @IsString()
  @Length(1, 64)
  liveSessionId!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 300)
  resultNotes?: string;
}
