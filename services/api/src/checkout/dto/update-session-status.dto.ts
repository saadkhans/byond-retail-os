import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckoutSessionStatus } from '@prisma/client';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Status targets reachable via PATCH. COMPLETED is deliberately absent —
 * completion consumes inventory and creates an order, so it only happens
 * through POST /checkout-sessions/:id/complete. OPEN is absent because no
 * state transitions back to OPEN.
 */
export const PATCHABLE_SESSION_STATUSES = [
  CheckoutSessionStatus.ACTIVE,
  CheckoutSessionStatus.PENDING_REVIEW,
  CheckoutSessionStatus.CANCELLED,
  CheckoutSessionStatus.EXPIRED,
] as const;

export class UpdateSessionStatusDto {
  @ApiProperty({
    enum: PATCHABLE_SESSION_STATUSES,
    description:
      'Target lifecycle status. COMPLETED is only reachable via the ' +
      '/complete endpoint; terminal sessions (COMPLETED/CANCELLED/EXPIRED) ' +
      'reject all transitions.',
  })
  @IsIn(PATCHABLE_SESSION_STATUSES)
  status!: (typeof PATCHABLE_SESSION_STATUSES)[number];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}
