import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Operator-selectable subset: ROLLBACK is set by the rollback endpoint only. */
export const CREATABLE_PRICE_CHANGE_REASONS = [
  'INITIAL',
  'PRICE_CHANGE',
  'PROMOTION_BASE',
  'CORRECTION',
] as const;
export type CreatablePriceChangeReason =
  (typeof CREATABLE_PRICE_CHANGE_REASONS)[number];

export class CreateVersionDto {
  @ApiPropertyOptional({ enum: CREATABLE_PRICE_CHANGE_REASONS })
  @IsOptional()
  @IsIn(CREATABLE_PRICE_CHANGE_REASONS)
  reason?: CreatablePriceChangeReason;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Why this price change is being made. Lands in the audit log, so it ' +
      'is screened for credential- and payment-bearing text.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description:
      'ISO-8601 instant the version should start applying. Defaults to the ' +
      'moment of activation; a future value schedules the change.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    description:
      'Seed the new draft with a copy of this version’s entries, so a small ' +
      'change does not mean re-sending the whole book.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  copyFromVersionId?: string;
}
