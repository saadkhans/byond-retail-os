import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentProvider } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PG_INT_MAX } from '../../common/integer-bounds';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Creates a provider-abstract payment intent. NO live gateway is called: the
 * intent starts CREATED and moves through the SIMULATED state machine.
 *
 * SECURITY: `providerRef`/`providerCustomerRef` are OPAQUE references only,
 * and `instrument*` fields are SAFE card metadata only (brand, last4, expiry,
 * wallet). Raw PAN/CVV/PIN/track data, tokens, API keys, and secrets are
 * REJECTED (controlled 400) before any write — never accept or store them.
 */
export class CreatePaymentIntentDto {
  @ApiPropertyOptional({
    description:
      'Optional order to link. Must belong to the caller’s tenant. An intent ' +
      'may be created before an order exists and bound later.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  orderId?: string;

  @ApiPropertyOptional({
    description:
      'Optional checkout session to link (walk-out: payment association ' +
      'happens before/during checkout). Must belong to the caller’s tenant.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  checkoutSessionId?: string;

  @ApiPropertyOptional({
    enum: PaymentProvider,
    default: PaymentProvider.SIMULATED,
    description:
      'Provider-neutral provider tag. SIMULATED is the built-in simulator; ' +
      'MANUAL is a staff-recorded reference. No real gateway in this phase.',
  })
  @IsOptionalNonNull()
  @IsEnum(PaymentProvider)
  provider?: PaymentProvider;

  @ApiProperty({
    minimum: 0,
    maximum: PG_INT_MAX,
    description: 'Amount to authorize/capture, in minor currency units.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(PG_INT_MAX)
  amountMinor!: number;

  @ApiProperty({
    example: 'SAR',
    description: 'ISO 4217 currency code (three uppercase letters).',
  })
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currencyCode must be a three-letter uppercase ISO 4217 code',
  })
  currencyCode!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Opaque provider reference for this intent (never a secret).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerRef?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Opaque provider customer/instrument reference (never a token secret).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  providerCustomerRef?: string;

  @ApiPropertyOptional({
    maxLength: 40,
    description: 'SAFE card brand metadata (e.g. VISA, MADA). Never a PAN.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  instrumentBrand?: string;

  @ApiPropertyOptional({
    description: 'SAFE last four digits only — exactly four digits, never a fuller PAN.',
    example: '4242',
  })
  @IsOptionalNonNull()
  @IsString()
  @Matches(/^[0-9]{4}$/, {
    message: 'instrumentLast4 must be exactly four digits',
  })
  instrumentLast4?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  instrumentExpiryMonth?: number;

  @ApiPropertyOptional({ minimum: 2000, maximum: 2100 })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  instrumentExpiryYear?: number;

  @ApiPropertyOptional({
    maxLength: 40,
    description: 'SAFE wallet type metadata (e.g. APPLE_PAY, GOOGLE_PAY).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  instrumentWallet?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Free-form description.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Tenant-scoped idempotency key. A duplicate create with the same key ' +
      'returns the original intent instead of creating another.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
