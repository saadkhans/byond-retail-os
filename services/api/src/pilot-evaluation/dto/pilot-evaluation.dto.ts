import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PilotEvaluationRunStatus,
  PilotExpectedAction,
  PilotObservationVerdict,
} from '@prisma/client';
import { IsEnum, IsIn, IsString, Length } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/** Phase 15 — pilot evaluation DTOs. Whitelisted fields only: predicted
 *  snapshots, counters, and provenance are runtime-owned and never
 *  caller-supplied. */

export class CreateEvaluationRunDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiPropertyOptional({ description: 'Store (location) id, tenant-scoped' })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  locationId?: string;
}

export class SetEvaluationStatusDto {
  @ApiProperty({ enum: ['COMPLETED', 'CANCELLED'] })
  @IsIn([
    PilotEvaluationRunStatus.COMPLETED,
    PilotEvaluationRunStatus.CANCELLED,
  ])
  status!: PilotEvaluationRunStatus;
}

export class AttachEvaluationSessionDto {
  @ApiProperty({ description: 'Live session id, tenant-scoped' })
  @IsString()
  @Length(1, 64)
  liveSessionId!: string;
}

export class ReviewObservationDto {
  @ApiProperty({ enum: PilotObservationVerdict })
  @IsEnum(PilotObservationVerdict)
  verdict!: PilotObservationVerdict;

  @ApiProperty({ enum: PilotExpectedAction })
  @IsEnum(PilotExpectedAction)
  expectedAction!: PilotExpectedAction;

  @ApiPropertyOptional({
    description: 'Live observation (journey event) id — required for every verdict except MISSED_EVENT',
  })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  journeyEventId?: string;

  @ApiPropertyOptional({
    description: 'Attached live session id — required for MISSED_EVENT',
  })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  liveSessionId?: string;

  @ApiPropertyOptional({
    description: 'Corrected/confirmed product id, tenant-scoped',
  })
  @IsOptionalNonNull()
  @IsString()
  @Length(1, 64)
  expectedProductId?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptionalNonNull()
  @IsString()
  @Length(0, 300)
  notes?: string;
}
