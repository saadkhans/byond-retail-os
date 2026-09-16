import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

/**
 * Ceiling on a single movement. Well inside PostgreSQL INTEGER, and far above
 * any legitimate single accrual — a larger number is a data-entry error, not
 * a loyalty programme.
 */
const MAX_POINTS_PER_MOVEMENT = 100_000_000;

class PointMovementBaseDto {
  @ApiProperty({
    maxLength: 40,
    description:
      'Uppercase reason code from the operator vocabulary (PURCHASE, ' +
      'GOODWILL, CAMPAIGN_Q3). Not free text — the justification goes in ' +
      '`note`.',
  })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/)
  reasonCode!: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Operator justification. Screened free text: it is persisted AND ' +
      'copied into AuditLog.reason, so a credential- or payment-bearing ' +
      'value is rejected rather than retained forever.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: 'Order this movement is attributable to, in this tenant.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  orderId?: string;

  @ApiProperty({
    maxLength: 120,
    description:
      'Tenant-scoped replay key. A repeat of the same key returns the ' +
      'ORIGINAL movement instead of moving points twice — required, because ' +
      'a retried redemption that spent points twice is unrecoverable on an ' +
      'append-only ledger.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/)
  idempotencyKey!: string;
}

export class AccruePointsDto extends PointMovementBaseDto {
  @ApiProperty({
    minimum: 1,
    maximum: MAX_POINTS_PER_MOVEMENT,
    description: 'Points to add. Positive magnitude; the sign is implied.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_POINTS_PER_MOVEMENT)
  points!: number;
}

export class RedeemPointsDto extends PointMovementBaseDto {
  @ApiProperty({
    minimum: 1,
    maximum: MAX_POINTS_PER_MOVEMENT,
    description:
      'Points to spend. Positive magnitude; the sign is implied. The ' +
      'balance floor is enforced inside the write — an overdraw is a 409, ' +
      'never a negative balance.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_POINTS_PER_MOVEMENT)
  points!: number;
}

export class AdjustPointsDto extends PointMovementBaseDto {
  @ApiProperty({
    enum: ['ADJUSTMENT', 'EXPIRY', 'REVERSAL'],
    description:
      'ADJUSTMENT and REVERSAL carry the sign of `points`; EXPIRY always ' +
      'removes. A mistake is corrected by appending a REVERSAL — movements ' +
      'are never edited or deleted.',
  })
  @IsIn(['ADJUSTMENT', 'EXPIRY', 'REVERSAL'])
  type!: 'ADJUSTMENT' | 'EXPIRY' | 'REVERSAL';

  @ApiProperty({
    minimum: -MAX_POINTS_PER_MOVEMENT,
    maximum: MAX_POINTS_PER_MOVEMENT,
    description: 'Signed for ADJUSTMENT/REVERSAL. Never zero.',
  })
  @IsInt()
  @Min(-MAX_POINTS_PER_MOVEMENT)
  @Max(MAX_POINTS_PER_MOVEMENT)
  @NotEquals(0)
  points!: number;
}
