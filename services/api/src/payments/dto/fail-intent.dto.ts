import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Simulates a payment failure/decline on a non-terminal intent (→ FAILED). A
 * linked order projects PAYMENT_FAILED — never PAID. The reason flows into the
 * audit log and is screened for credential-/payment-bearing values.
 */
export class FailIntentDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Operator/simulated reason for the failure.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}
