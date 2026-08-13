import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Closed screening vocabulary — exactly two outcomes, no free-text
 * decisions. APPROVE releases a QUARANTINED upload for processing
 * (QUARANTINED → UPLOADED); REJECT removes the stored media and parks the
 * metadata row as evidence (QUARANTINED → REJECTED).
 */
export enum VideoScreeningDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

/**
 * The audited frame-content screening decision for a QUARANTINED upload.
 * The upload-time attestation is defense-in-depth only — THIS decision is
 * the enforced control that stands between stored bytes and any processing.
 * A later phase plugs an automated CV frame screener into the same step.
 */
export class ScreenVideoAssetDto {
  @ApiProperty({
    enum: VideoScreeningDecision,
    description:
      'APPROVE releases the quarantined upload for processing; REJECT ' +
      'removes the stored media (metadata row kept as evidence). Closed ' +
      'vocabulary — any other value is a controlled 400.',
  })
  @IsEnum(VideoScreeningDecision)
  decision!: VideoScreeningDecision;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Screener note recorded in the audit trail with the decision. ' +
      'Screened before persistence: credential- or payment-bearing content ' +
      'is a controlled 400 (same policy as Phase 7 review reasons).',
  })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}
