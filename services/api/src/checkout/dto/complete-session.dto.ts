import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

export class CompleteSessionDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key (recommended). A duplicate completion ' +
      'request with the same key returns the already-created order instead ' +
      'of consuming inventory twice.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
