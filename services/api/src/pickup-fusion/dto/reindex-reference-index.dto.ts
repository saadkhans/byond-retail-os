import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Runtime-validated body for the reference-embedding reindex endpoint.
 * Without this DTO the inline body type carried no validation metadata,
 * so the global whitelist ValidationPipe skipped it entirely: arbitrary
 * junk keys and non-boolean `rebuild` values sailed past the HTTP layer
 * of an endpoint whose `rebuild: true` branch gates a destructive
 * deleteMany over the tenant's embedding index. The strict `=== true`
 * check in the controller stays as defense in depth; this DTO makes the
 * wire contract explicit — `rebuild` is an optional real boolean, and
 * anything else is a controlled 400.
 */
export class ReindexReferenceIndexDto {
  @ApiPropertyOptional({
    description:
      'When true, delete the tenant’s existing embeddings for the current ' +
      'model before rebuilding the index; otherwise only fill gaps.',
  })
  @IsOptionalNonNull()
  @IsBoolean()
  rebuild?: boolean;
}
