import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * Binds a still-unbound PENDING_REVIEW event to a checkout session — the
 * audited correlation step for events ingested before the shopper's session
 * was known. Binding never touches the basket; only approval does.
 */
export class BindVisionEventSessionDto {
  @ApiProperty({
    description:
      'Checkout session to bind the event to (must be on the same unit as ' +
      'the event).',
  })
  @IsString()
  @MinLength(1)
  sessionId!: string;
}
