import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Phase 27 — refunds money against a CAPTURED intent, through the owned
 * refund-gateway port (SIMULATED only; no live gateway).
 *
 * `amountMinor` is always explicit: there is no "refund everything" shortcut,
 * because a caller that cannot say how much it means to return should not be
 * moving money. The server bounds it by what the intent actually captured
 * minus what has already been refunded or is in flight.
 *
 * The `idempotencyKey` is what makes a replayed request safe: the same key
 * re-reads the original refund instead of paying the shopper twice. It is
 * screened like every other payment string — no credentials, no bare
 * CVV/PIN-shaped digits.
 */
export class RefundIntentDto {
  @ApiProperty({
    minimum: 1,
    description:
      'Amount to return, in minor currency units. Never more than the ' +
      'intent captured, less anything already refunded or in flight.',
  })
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Operator reason for the refund. Persisted and audited — must not ' +
      'contain credential- or payment-bearing values.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Opaque provider refund reference (never a secret).',
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
      'refund with the same key never moves money twice.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
