import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Runtime-validated body for the fusion-run import. Without this DTO an
 * empty body reached the service with `videoAssetId === undefined`, and
 * Prisma's undefined-field semantics silently dropped the predicate —
 * selecting the tenant's latest fusion run from ANY video.
 */
export class FromFusionRunDto {
  @ApiProperty({ description: 'Video asset whose latest fusion run to import' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  videoAssetId!: string;
}
