import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';
import { EvidenceRefsDto } from './evidence-refs.dto';

export class CreateCheckoutSessionDto extends EvidenceRefsDto {
  @ApiProperty({ description: 'The store (location) this session runs in.' })
  @IsString()
  @MinLength(1)
  locationId!: string;

  @ApiProperty({
    description:
      'The retail unit this session runs on; must belong to the store above.',
  })
  @IsString()
  @MinLength(1)
  unitId!: string;

  @ApiPropertyOptional({
    description: 'Optional source device (no edge runtime in Phase 5).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  deviceId?: string;

  @ApiPropertyOptional({
    description:
      'Loyalty account (member) this basket is shopped under. Captured when ' +
      'the session OPENS, so a promotion decision taken on a line can never ' +
      'be changed by identifying later. Must be an ACTIVE account in this ' +
      'tenant; omit for a non-member basket.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  loyaltyAccountId?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key: retrying the same create returns the ' +
      'original session instead of opening a duplicate.',
  })
  // Persisted verbatim → screened by assertSafeIdempotencyKey in the
  // service (no credential- or payment-bearing values), like evidence refs.
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
