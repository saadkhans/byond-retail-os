import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Simulates a full capture of an AUTHORIZED/CAPTURE_PENDING intent. The
 * idempotencyKey is the last-line backstop against a DOUBLE CAPTURE: retrying
 * with the same key replays the original capture instead of capturing twice.
 */
export class CaptureIntentDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Opaque provider capture reference (never a secret).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerRef?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key. STRONGLY recommended — a duplicate ' +
      'capture with the same key never moves money twice.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
