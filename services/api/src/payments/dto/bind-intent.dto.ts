import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Binds a previously-unlinked (or session-only) payment intent to an order
 * and/or checkout session AFTER creation — the association the create endpoint
 * promises but could not perform up front (walk-out: pay first, associate to
 * the eventual order later). At least one target is required. Binding to an
 * order immediately projects the intent's current state onto that order (a
 * CAPTURED intent marks it PAID). Re-binding to the SAME target replays;
 * re-binding to a DIFFERENT order/session is a controlled conflict.
 */
export class BindIntentDto {
  @ApiPropertyOptional({
    description:
      'Order to bind to (same tenant). Binding a CAPTURED intent marks the ' +
      'order PAID immediately.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  orderId?: string;

  @ApiPropertyOptional({
    description: 'Checkout session to bind to (same tenant).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  checkoutSessionId?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Tenant-scoped idempotency key for the bind call.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
