import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Runtime-validated body for opening a journey. Without this DTO the
 * inline body type carried no validation metadata, so the global
 * whitelist ValidationPipe skipped it entirely: an empty body reached
 * the service with `locationId === undefined` (Prisma dropped the id
 * predicate and the existence check passed against an arbitrary tenant
 * location before the create 500'd), and an operator object like
 * `{"locationId": {"not": ""}}` injected a Prisma StringFilter into the
 * where clause.
 */
export class CreateJourneyDto {
  @ApiProperty({ description: 'Location where the journey opens' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  locationId!: string;

  @ApiPropertyOptional({ description: 'Business unit within the location' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  unitId?: string;
}
