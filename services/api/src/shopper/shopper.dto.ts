import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Phase 35 — the one body the shopper surface accepts.
 *
 * Note what is NOT here and never will be: no tenant id, no store id, no
 * unit id, no journey id, no shopper id. Every one of those is read off the
 * credential server-side. A shopper cannot name them, so a shopper cannot
 * reach someone else's.
 *
 * Note also what is not here on the payment side: nothing at all. Payment is
 * Phase 6's provider-neutral intent state machine, driven by Phase 26's exit,
 * with `SIMULATED` as the only provider this repository has. The shopper
 * submits no payment instrument of any kind, so there is no payment-instrument
 * path here to add a field to — and boundary.spec.ts fails if one appears.
 */
export class EnterStoreDto {
  @ApiProperty({
    description:
      'The entry credential handed out at the door. Matched by digest and ' +
      'burned on first use. The same validation Phase 26 applies to it.',
    maxLength: 200,
  })
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'token must be a base64url string',
  })
  token!: string;
}
