import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Claims a QUEUED job for an adapter (QUEUED → RUNNING). The adapter must
 * be registered and support the job's type; Phase 9 registers only the
 * simulated adapter.
 */
export class StartInferenceJobDto {
  @ApiPropertyOptional({
    default: 'simulated',
    maxLength: 100,
    description: 'Registered adapter key to run the job with.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  adapterKey?: string;
}
