import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { EvidenceBundle } from '@prisma/client';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import { CurrentTenantId } from '../auth/decorators/request-context.decorators';
import { VisionEventsService } from './vision-events.service';

@ApiTags('evidence-bundles')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('evidence-bundles')
export class EvidenceBundlesController {
  constructor(private readonly eventsService: VisionEventsService) {}

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary: 'Get an evidence bundle lineage record',
    description:
      'A lightweight lineage record (sourceType and capture window) that ' +
      'events, reviews, and basket lines reference by id. Phase 7 does not ' +
      'accept evidence artifacts or external media references; evidence ' +
      'media storage is deferred to a future evidence storage phase. ' +
      'Bundles are append-only (tamper-evident); they are created inline ' +
      'with event ingestion, never mutated.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<EvidenceBundle> {
    return this.eventsService.findBundleById(tenantId, id);
  }
}
