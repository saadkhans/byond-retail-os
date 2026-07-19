import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentEventType, PaymentProvider } from '@prisma/client';
import {
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Ingests a SIMULATED provider event (authenticated/admin-only foundation, not
 * a public webhook). ONLY normalized fields are accepted and stored — there is
 * NO raw provider payload, NO webhook signature/secret verification in this
 * phase. Duplicate (provider, providerEventId) is idempotent.
 */
export class SimulatePaymentEventDto {
  @ApiProperty({
    enum: PaymentProvider,
    default: PaymentProvider.SIMULATED,
  })
  @IsEnum(PaymentProvider)
  provider!: PaymentProvider;

  @ApiProperty({
    maxLength: 200,
    description:
      'Opaque provider event id — unique per tenant/provider (dedupe key).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerEventId!: string;

  @ApiProperty({
    enum: PaymentEventType,
    description:
      'Normalized, provider-neutral event type. UNKNOWN is safely recorded ' +
      'as IGNORED.',
  })
  @IsEnum(PaymentEventType)
  eventType!: PaymentEventType;

  @ApiPropertyOptional({
    description: 'Optional payment intent to associate (must be same tenant).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  intentId?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Opaque provider reference carried by the event (never a secret).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerRef?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Tenant-scoped idempotency key for the ingest call.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
