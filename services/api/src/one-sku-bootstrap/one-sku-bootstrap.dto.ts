import { PilotExpectedAction, PilotObservationVerdict } from '@prisma/client';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { BOOTSTRAP_REVIEW_VERDICTS } from './one-sku-bootstrap.service';

/**
 * One bootstrap correction. Deliberately NARROW: the verdict subset
 * excludes MISSED_EVENT (needs an attached live session), predicted*
 * snapshots are server-side only, and notes go through Phase 15's
 * sensitive-content screen. No field can carry a path, URL, or source
 * reference by construction.
 */
export class BootstrapReviewDto {
  @IsIn(BOOTSTRAP_REVIEW_VERDICTS as readonly PilotObservationVerdict[])
  verdict!: PilotObservationVerdict;

  @IsIn(Object.values(PilotExpectedAction))
  expectedAction!: PilotExpectedAction;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  expectedProductId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  notes?: string;
}
