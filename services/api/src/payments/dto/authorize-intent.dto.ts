import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/** Simulates a provider authorization hold on a CREATED/REQUIRES_AUTHORIZATION intent. */
export class AuthorizeIntentDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Opaque provider authorization reference (never a secret).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerRef?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key. Retrying with the same key replays the ' +
      'authorization instead of holding funds twice.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
