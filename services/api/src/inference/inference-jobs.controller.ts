import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
import { VisionEventDetail } from '../vision/vision-events.repository';
import { CompleteInferenceJobDto } from './dto/complete-inference-job.dto';
import { CreateInferenceJobDto } from './dto/create-inference-job.dto';
import { FailInferenceJobDto } from './dto/fail-inference-job.dto';
import { QueryInferenceJobsDto } from './dto/query-inference-jobs.dto';
import { StartInferenceJobDto } from './dto/start-inference-job.dto';
import {
  InferenceJobDetail,
  InferenceJobWithRefs,
} from './inference-jobs.repository';
import { InferenceJobsService } from './inference-jobs.service';

@ApiTags('inference')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('inference')
@Controller('inference/jobs')
export class InferenceJobsController {
  constructor(private readonly jobsService: InferenceJobsService) {}

  @Post()
  @RequirePermissions('inference:manage')
  @ApiOperation({
    summary: 'Queue a provider-neutral inference job',
    description:
      'The trigger layer (hand-in-shelf-zone, suspected shelf change, ' +
      'customer exit, ...) submits typed context only: job type, optional ' +
      'store/unit/device/session binding, priority, and a SAFE input ' +
      'descriptor that references crops/zones/frames BY ID — raw media, ' +
      'media/storage URLs, signed URLs, artifact descriptors, and ' +
      'credential-shaped content are controlled 400s. No model runs at ' +
      'creation time and nothing touches the basket. Retrying with the ' +
      'same idempotencyKey returns the original job.',
  })
  @ApiCreatedResponse({ description: 'Job queued (QUEUED)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateInferenceJobDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<InferenceJobDetail> {
    return this.jobsService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('inference:read')
  @ApiOperation({
    summary: 'List inference jobs in the caller’s tenant',
    description:
      'Filters: status, jobType, session, store, unit. Deterministic ' +
      'ordering (newest requestedAt first, id tie-breaker), paginated via ' +
      'skip/take.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryInferenceJobsDto,
  ): Promise<{
    items: InferenceJobWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.jobsService.search(tenantId, query);
  }

  // Declared BEFORE the ':id' routes so Nest does not swallow the literal
  // path segment as a job id.
  @Post('reclaim-expired')
  @RequirePermissions('inference:manage')
  @ApiOperation({
    summary: 'Reclaim RUNNING jobs whose lease expired',
    description:
      'Operator-triggered recovery for crashed/hung workers: every RUNNING ' +
      'job in the tenant whose lease expired returns to QUEUED while ' +
      'attempts remain, or FAILS with LEASE_EXPIRED once the attempt ' +
      'budget is spent. The same sweep runs automatically before every ' +
      'claim/start; this endpoint recovers a stranded job without waiting ' +
      'for an unrelated start. Every reclaim is audited as a system action.',
  })
  @ApiCreatedResponse({ description: 'Reclaimed jobs returned (may be empty)' })
  reclaimExpired(
    @CurrentTenantId() tenantId: string,
  ): Promise<{ reclaimed: InferenceJobDetail[] }> {
    return this.jobsService.reclaimExpired(tenantId);
  }

  @Get(':id')
  @RequirePermissions('inference:read')
  @ApiOperation({
    summary: 'Get an inference job with its result and ranked candidates',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<InferenceJobDetail> {
    return this.jobsService.findById(tenantId, id);
  }

  @Post(':id/start')
  @RequirePermissions('inference:manage')
  @ApiOperation({
    summary: 'Start a queued job (QUEUED → RUNNING)',
    description:
      'Claims the job for a registered adapter (default "simulated" — the ' +
      'only Phase 9 adapter; no real model runs). The adapter must support ' +
      'the job type. Claiming is a tenant-scoped compare-and-set, so two ' +
      'concurrent starts cannot both win.',
  })
  @ApiCreatedResponse({ description: 'Job running; job returned' })
  @ApiNotFoundResponse({ description: 'Job not found in this tenant' })
  @ApiConflictResponse({ description: 'Job is not QUEUED' })
  start(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: StartInferenceJobDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<InferenceJobDetail> {
    return this.jobsService.start(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/complete')
  @RequirePermissions('inference:simulate')
  @ApiOperation({
    summary: 'Complete a running job with simulated model output',
    description:
      'RUNNING → SUCCEEDED. The sample output (eventType, signed ' +
      'quantityDelta, raw detections) runs through the job’s adapter: ' +
      'validation plus candidate ranking with exact Phase 8 mapper parity ' +
      '(dedupe by uppercased SKU keeping the strongest, sort by confidence ' +
      'descending, 1-based ranks, scores rounded to 4 decimals, cap 20). ' +
      'The append-only result and its candidates commit atomically with ' +
      'the status flip. No real model executes in Phase 9.',
  })
  @ApiCreatedResponse({ description: 'Job succeeded; job returned' })
  @ApiNotFoundResponse({ description: 'Job not found in this tenant' })
  @ApiConflictResponse({ description: 'Job is not RUNNING or already terminal' })
  complete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CompleteInferenceJobDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<InferenceJobDetail> {
    return this.jobsService.complete(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/fail')
  @RequirePermissions('inference:manage')
  @ApiOperation({
    summary: 'Fail a queued or running job',
    description:
      'QUEUED/RUNNING → FAILED with a stable UPPER_SNAKE error code and an ' +
      'optional screened message. Terminal jobs never transition again.',
  })
  @ApiCreatedResponse({ description: 'Job failed; job returned' })
  @ApiNotFoundResponse({ description: 'Job not found in this tenant' })
  @ApiConflictResponse({ description: 'Job is already terminal' })
  fail(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: FailInferenceJobDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<InferenceJobDetail> {
    return this.jobsService.fail(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/to-vision-event')
  @RequirePermissions('inference:apply')
  @ApiOperation({
    summary: 'Convert a succeeded job’s result into a Phase 7 vision event',
    description:
      'Builds a Phase 7-compatible ingest payload from the normalized ' +
      'result (type from the suggestion, quantity = |quantityDelta|, the ' +
      'ranked candidates, evidence score/quality, the job’s store/unit/' +
      'device/session binding) and creates the vision event through the ' +
      'EXISTING ingest contract: it lands in PENDING_REVIEW and NEVER ' +
      'touches the basket — only an approved review decision does. ' +
      'Conversion is one-shot and idempotent (the vision idempotency key ' +
      'is derived from the job id); re-converting replays the linked ' +
      'event. Requires the cv module enabled and a job with store + unit.',
  })
  @ApiCreatedResponse({ description: 'Vision event created (or replayed)' })
  @ApiNotFoundResponse({ description: 'Job not found in this tenant' })
  @ApiConflictResponse({
    description: 'Job not SUCCEEDED, no result, or missing store/unit',
  })
  toVisionEvent(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<{
    job: InferenceJobDetail;
    visionEvent: VisionEventDetail;
    replayed: boolean;
  }> {
    return this.jobsService.toVisionEvent(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
