import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Cancels a pre-auth intent (→ CANCELLED) or voids an authorized one
 * (→ VOIDED). The reason flows into the audit log — it must not carry
 * credential- or payment-bearing values (screened, controlled 400).
 */
export class CancelIntentDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Operator reason for the cancellation/void.',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}
