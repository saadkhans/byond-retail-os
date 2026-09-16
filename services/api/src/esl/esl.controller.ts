import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
import {
  CreateGatewayDto,
  ProcessJobsDto,
  QueryGatewaysDto,
  QueryJobsDto,
  QueryLabelsDto,
  RegisterLabelDto,
  UpdateGatewayDto,
  UpdateLabelDto,
} from './dto/esl.dto';
import { ESL_MODULE_CODE } from './esl.constants';
import {
  EslGatewayDetail,
  EslLabelDetail,
  EslUpdateJobDetail,
} from './esl.repository';
import { EslProcessSummary, EslService } from './esl.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(); a tenantId in the body is rejected by the global
// whitelist ValidationPipe.
@ApiTags('esl')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(ESL_MODULE_CODE)
@Controller('esl')
export class EslController {
  constructor(private readonly eslService: EslService) {}

  // ------------------------------------------------------------- gateways

  @Get('vendors')
  @RequirePermissions('esl-gateway:read')
  @ApiOperation({
    summary: 'List the ESL vendor adapters this deployment offers',
    description:
      'Vendor codes accepted when registering a gateway. SIMULATED is always ' +
      'present; a real vendor is an adapter behind EslVendorPort.',
  })
  vendors(): { vendorCodes: string[] } {
    return { vendorCodes: this.eslService.vendorCodes() };
  }

  @Get('gateways')
  @RequirePermissions('esl-gateway:read')
  @ApiOperation({ summary: 'List ESL gateways in the caller’s tenant' })
  listGateways(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryGatewaysDto,
  ): Promise<{ items: EslGatewayDetail[]; total: number }> {
    return this.eslService.findGateways(tenantId, query);
  }

  @Post('gateways')
  @RequirePermissions('esl-gateway:manage')
  @ApiOperation({ summary: 'Register an ESL gateway' })
  @ApiCreatedResponse({ description: 'Gateway registered' })
  @ApiConflictResponse({ description: 'The code is already used' })
  createGateway(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateGatewayDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<EslGatewayDetail> {
    return this.eslService.createGateway(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get('gateways/:id')
  @RequirePermissions('esl-gateway:read')
  @ApiOperation({ summary: 'Read one ESL gateway' })
  @ApiNotFoundResponse({ description: 'No such gateway in this tenant' })
  findGateway(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<EslGatewayDetail> {
    return this.eslService.findGatewayById(tenantId, id);
  }

  @Patch('gateways/:id')
  @RequirePermissions('esl-gateway:manage')
  @ApiOperation({
    summary: 'Update an ESL gateway',
    description:
      'Disabling a gateway cancels the work queued for its labels: those ' +
      'pushes can never succeed against hardware an operator switched off.',
  })
  updateGateway(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateGatewayDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<EslGatewayDetail> {
    return this.eslService.updateGateway(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('gateways/:id/discover')
  @RequirePermissions('esl-gateway:manage')
  @ApiOperation({
    summary: 'Ask the gateway which labels it can see, and register them',
    description:
      'Idempotent: a label already known has its health refreshed and its ' +
      'product binding left alone.',
  })
  @ApiConflictResponse({ description: 'The gateway could not be reached' })
  discover(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<{ registered: number; labels: EslLabelDetail[] }> {
    return this.eslService.discoverLabels(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('gateways/:id/labels')
  @RequirePermissions('esl-label:manage')
  @ApiOperation({ summary: 'Register one label on a gateway by hand' })
  @ApiCreatedResponse({ description: 'Label registered' })
  registerLabel(
    @CurrentTenantId() tenantId: string,
    @Param('id') gatewayId: string,
    @Body() dto: RegisterLabelDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<EslLabelDetail> {
    return this.eslService.registerLabel(tenantId, gatewayId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  // --------------------------------------------------------------- labels

  @Get('labels')
  @RequirePermissions('esl-label:read')
  @ApiOperation({ summary: 'List labels in the caller’s tenant' })
  listLabels(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryLabelsDto,
  ): Promise<{ items: EslLabelDetail[]; total: number }> {
    return this.eslService.findLabels(tenantId, query);
  }

  @Get('labels/:id')
  @RequirePermissions('esl-label:read')
  @ApiOperation({ summary: 'Read one label' })
  @ApiNotFoundResponse({ description: 'No such label in this tenant' })
  findLabel(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<EslLabelDetail> {
    return this.eslService.findLabelById(tenantId, id);
  }

  @Patch('labels/:id')
  @RequirePermissions('esl-label:manage')
  @ApiOperation({
    summary: 'Bind a label to a product, move it, or retire it',
    description:
      'Binding a product is what makes a label eligible for price ' +
      'propagation, and queues an immediate render. Retirement is one-way.',
  })
  @ApiConflictResponse({ description: 'The label is RETIRED' })
  updateLabel(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateLabelDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<EslLabelDetail> {
    return this.eslService.updateLabel(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post('labels/:id/render')
  @RequirePermissions('esl-label:manage')
  @ApiOperation({
    summary: 'Queue a re-render of one label',
    description:
      'For hardware that was just replaced or is suspected of showing a ' +
      'stale price. Never de-duplicated — asking twice means it twice.',
  })
  render(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<{ enqueued: number }> {
    return this.eslService.requestRender(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }

  // ----------------------------------------------------------------- jobs

  @Get('update-jobs')
  @RequirePermissions('esl-job:read')
  @ApiOperation({ summary: 'List label update jobs, newest first' })
  listJobs(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryJobsDto,
  ): Promise<{ items: EslUpdateJobDetail[]; total: number }> {
    return this.eslService.findJobs(tenantId, query);
  }

  @Post('update-jobs/process')
  @RequirePermissions('esl-job:process')
  @ApiOperation({
    summary: 'Run one processing pass',
    description:
      'Recovers stranded work, claims a batch, and pushes it to the vendors ' +
      'one gateway at a time. A failing label never blocks another.',
  })
  process(
    @CurrentTenantId() tenantId: string,
    @Body() dto: ProcessJobsDto,
  ): Promise<EslProcessSummary> {
    return this.eslService.processBatch(tenantId, dto.limit);
  }

  @Post('update-jobs/reclaim-expired')
  @RequirePermissions('esl-job:process')
  @ApiOperation({
    summary: 'Requeue jobs whose worker lease expired',
    description:
      'Runs the same sweep a processing pass begins with, so a job stranded ' +
      'by a crashed worker is recoverable from the admin UI on demand.',
  })
  reclaim(
    @CurrentTenantId() tenantId: string,
  ): Promise<{ requeued: number; failed: number }> {
    return this.eslService.reclaimExpired(tenantId);
  }

  @Post('reconcile')
  @RequirePermissions('esl-job:process')
  @ApiOperation({
    summary: 'Queue a render for every label showing the wrong price',
    description:
      'The repair path for the best-effort activation hand-off: a listener ' +
      'that was down when a price changed is caught here.',
  })
  reconcile(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<{ inspected: number; enqueued: number }> {
    return this.eslService.reconcile(tenantId, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
