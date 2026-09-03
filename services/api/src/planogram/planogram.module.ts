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
import { PublishPlanogramRackDto } from './planogram.dto';
import { PlanogramService } from './planogram.service';
import { planogramMatchStatusFor } from './planogram.logic';

/**
 * Phase 19 — planogram (rack/shelf/cell) management. Planograms are a
 * SOFT scoring prior for SKU candidate narrowing: catalog-level data,
 * no video-derived metadata, no basket/order/payment/inventory writes
 * (see shadow-mode.spec.ts). Reads need vision:read; publishing and
 * deactivating layouts need vision:review.
 */
@ApiTags('planograms')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('planograms')
export class PlanogramController {
  constructor(private readonly planograms: PlanogramService) {}

  @Post('racks')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Publish a rack layout (rows × columns grid with per-cell SKU ' +
      'assignments). Re-publishing an existing rackCode deactivates the ' +
      'current ACTIVE version and creates version+1 — old evidence keeps ' +
      'the version it was scored against.',
  })
  publishRack(
    @CurrentTenantId() tenantId: string,
    @Body() body: PublishPlanogramRackDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.planograms.publishRack(
      tenantId,
      {
        locationId: body.locationId,
        rackCode: body.rackCode,
        name: body.name ?? null,
        rows: body.rows,
        columns: body.columns,
        cells: body.cells,
      },
      actor.userId,
    );
  }

  @Get('racks')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'ACTIVE rack layouts (optionally filtered to one store)',
  })
  listRacks(
    @CurrentTenantId() tenantId: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.planograms.listRacks(tenantId, locationId || undefined);
  }

  @Post('racks/:rackId/deactivate')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Deactivate a rack layout (kept queryable for evidence ' +
      'traceability — never deleted)',
  })
  async deactivateRack(
    @CurrentTenantId() tenantId: string,
    @Param('rackId') rackId: string,
  ) {
    await this.planograms.deactivateRack(tenantId, rackId);
    return { deactivated: true };
  }

  @Get('narrow')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Tiered SKU candidate narrowing for a normalized rack position — ' +
      'a SOFT prior (cell → adjacent → rack → full catalog fallback), ' +
      'never a rejection',
  })
  async narrow(
    @CurrentTenantId() tenantId: string,
    @Query('locationId') locationId: string,
    @Query('rackCode') rackCode: string,
    @Query('x') x?: string,
    @Query('y') y?: string,
    @Query('visualTopSku') visualTopSku?: string,
  ) {
    const parsed = (value?: string) => {
      const num = value === undefined || value === '' ? NaN : Number(value);
      return Number.isFinite(num) ? num : null;
    };
    const narrowed = await this.planograms.narrowCandidates(tenantId, {
      locationId,
      rackCode,
      normalizedRackX: parsed(x),
      normalizedRackY: parsed(y),
    });
    return {
      narrowed,
      matchStatus: planogramMatchStatusFor(visualTopSku ?? null, narrowed),
    };
  }
}

@Module({
  controllers: [PlanogramController],
  providers: [PlanogramService],
  exports: [PlanogramService],
})
export class PlanogramModule {}
