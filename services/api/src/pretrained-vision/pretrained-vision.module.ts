import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { LocalVisionRuntimeModule } from '../local-vision-runtime/local-vision-runtime.module';
import { PlanogramModule } from '../planogram/planogram.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { PretrainedVisionService } from './pretrained-vision.service';

/**
 * Phase 19 — pretrained retail vision evaluation surface. Everything
 * served here is video-derived shadow evidence: the report/evaluate
 * routes enforce the video-asset read boundary (video-ingest module +
 * video-asset:read) inside the service, on top of the cv module and
 * vision permissions here. No route mutates checkout, order, payment,
 * settlement, or inventory state (see shadow-mode.spec.ts).
 */

/** Where the planogram rack sits in the ANALYSIS frame (normalized,
 *  top-left origin). Omit when the rack fills the frame. Used ONLY to map
 *  the detector's localized event product onto rack coordinates when the
 *  operator supplied none. */
export class RackFrameRegionDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y!: number;

  @IsNumber()
  @Min(0.01)
  @Max(1)
  width!: number;

  @IsNumber()
  @Min(0.01)
  @Max(1)
  height!: number;
}

export class EvaluateClipDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  locationId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  rackCode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  normalizedRackX?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  normalizedRackY?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => RackFrameRegionDto)
  rackFrameRegion?: RackFrameRegionDto;
}

/** Query-string form of RackFrameRegionDto for the read-only report:
 *  all four of rx/ry/rw/rh must parse to 0..1 with a positive extent,
 *  otherwise the region is ignored (whole frame). Exported for tests. */
export function parseRackFrameRegionQuery(query: {
  rx?: string;
  ry?: string;
  rw?: string;
  rh?: string;
}): RackFrameRegionDto | null {
  const parse = (value?: string) => {
    const num = value === undefined || value === '' ? NaN : Number(value);
    return Number.isFinite(num) && num >= 0 && num <= 1 ? num : null;
  };
  const x = parse(query.rx);
  const y = parse(query.ry);
  const width = parse(query.rw);
  const height = parse(query.rh);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

@ApiTags('pretrained-vision')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('pretrained-vision')
export class PretrainedVisionController {
  constructor(private readonly vision: PretrainedVisionService) {}

  @Get('providers')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Registered LOCAL pretrained provider slots and their availability ' +
      '(READY / DISABLED / UNAVAILABLE) — the classical fallback is ' +
      'always registered and always READY',
  })
  async providers() {
    // providerStatuses() is async (real runtimes probe); Nest awaits only
    // the top-level return, so the array must be awaited HERE - a nested
    // promise would serialize as {} and break the admin page.
    return { providers: await this.vision.providerStatuses() };
  }

  @Post('videos/:videoAssetId/evaluate')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Run every registered local provider over the clip’s persisted ' +
      'classical context, store sanitized tenant-scoped evidence, and ' +
      'return the classical-vs-pretrained comparison (with optional ' +
      'planogram-aware SKU narrowing). Shadow-only — nothing is applied ' +
      'anywhere.',
  })
  evaluate(
    @CurrentTenantId() tenantId: string,
    @Param('videoAssetId') videoAssetId: string,
    @Body() body: EvaluateClipDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.vision.evaluate(
      tenantId,
      videoAssetId,
      {
        locationId: body.locationId ?? null,
        rackCode: body.rackCode ?? null,
        normalizedRackX: body.normalizedRackX ?? null,
        normalizedRackY: body.normalizedRackY ?? null,
        rackFrameRegion: body.rackFrameRegion ?? null,
      },
      actor.userId,
      {
        hasVideoAssetReadPermission:
          actor.permissions.includes('video-asset:read'),
      },
    );
  }

  @Get('videos/:videoAssetId/report')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Latest stored provider evidence per provider with the same ' +
      'comparison assembly — read-only',
  })
  report(
    @CurrentTenantId() tenantId: string,
    @Param('videoAssetId') videoAssetId: string,
    @CurrentUser() actor: RequestContext,
    @Query('locationId') locationId?: string,
    @Query('rackCode') rackCode?: string,
    @Query('x') x?: string,
    @Query('y') y?: string,
    @Query('rx') rx?: string,
    @Query('ry') ry?: string,
    @Query('rw') rw?: string,
    @Query('rh') rh?: string,
  ) {
    const parsed = (value?: string) => {
      const num = value === undefined || value === '' ? NaN : Number(value);
      return Number.isFinite(num) && num >= 0 && num <= 1 ? num : null;
    };
    return this.vision.report(
      tenantId,
      videoAssetId,
      {
        locationId: locationId || null,
        rackCode: rackCode || null,
        normalizedRackX: parsed(x),
        normalizedRackY: parsed(y),
        rackFrameRegion: parseRackFrameRegionQuery({ rx, ry, rw, rh }),
      },
      {
        hasVideoAssetReadPermission:
          actor.permissions.includes('video-asset:read'),
      },
    );
  }
}

@Module({
  // LocalVisionRuntimeModule binds the LOCAL_DETECTOR_RUNTIME port — the
  // only place a model file or worker process is ever touched. This
  // module consumes the port type alone.
  imports: [PlatformModulesModule, PlanogramModule, LocalVisionRuntimeModule],
  controllers: [PretrainedVisionController],
  providers: [PretrainedVisionService],
})
export class PretrainedVisionModule {}
