import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CvDatasetEligibility } from '@prisma/client';
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
import { PilotEvaluationModule } from '../pilot-evaluation/pilot-evaluation.module';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { CvDatasetService } from './cv-dataset.service';
import {
  CreateDatasetRunDto,
  SetDatasetRunStatusDto,
  UpdateDatasetRunDto,
} from './dto/cv-dataset.dto';

/**
 * Phase 18 — dataset improvement & model tuning, SHADOW ONLY and
 * advisory. Runs organize REVIEWED/CORRECTED Phase 15/16 labels into
 * candidate references, quality reports, deterministic split plans, a
 * safe export manifest, and an advisory tuning report. No route here
 * trains a model, calls an external model API, or touches checkout,
 * orders, payments, or inventory — and no response carries media, URL,
 * file path, credential, or model-weight material.
 */
@ApiTags('cv-dataset')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('cv-dataset-improvement-runs')
export class CvDatasetController {
  constructor(private readonly datasets: CvDatasetService) {}

  @Post()
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Create a dataset improvement run (DRAFT)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() body: CreateDatasetRunDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.datasets.createRun(
      tenantId,
      {
        name: body.name,
        purpose: body.purpose,
        sourceEvaluationRunId: body.sourceEvaluationRunId,
        sourceTestProtocolId: body.sourceTestProtocolId,
        sourceCalibrationProfileId: body.sourceCalibrationProfileId,
        trainSplitPercent: body.trainSplitPercent,
        validationSplitPercent: body.validationSplitPercent,
        testSplitPercent: body.testSplitPercent,
        minReviewedExamplesPerSku: body.minReviewedExamplesPerSku,
        minReviewedExamplesPerAction: body.minReviewedExamplesPerAction,
        notes: body.notes,
      },
      actor.userId,
    );
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Dataset improvement runs (newest first)' })
  list(@CurrentTenantId() tenantId: string) {
    return this.datasets.listRuns(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Run detail with candidate/split summary' })
  detail(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.datasets.runDetail(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Edit a DRAFT run (metadata and source links)' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: UpdateDatasetRunDto,
  ) {
    return this.datasets.updateRun(tenantId, id, {
      name: body.name,
      purpose: body.purpose,
      sourceEvaluationRunId: body.sourceEvaluationRunId,
      sourceTestProtocolId: body.sourceTestProtocolId,
      sourceCalibrationProfileId: body.sourceCalibrationProfileId,
      trainSplitPercent: body.trainSplitPercent,
      validationSplitPercent: body.validationSplitPercent,
      testSplitPercent: body.testSplitPercent,
      minReviewedExamplesPerSku: body.minReviewedExamplesPerSku,
      minReviewedExamplesPerAction: body.minReviewedExamplesPerAction,
      notes: body.notes,
    });
  }

  @Post(':id/status')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'DRAFT → READY (gated on quality readiness) or any → ARCHIVED. ' +
      'EXPORTED is stamped only by the export endpoint.',
  })
  setStatus(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: SetDatasetRunStatusDto,
  ) {
    return this.datasets.setStatus(tenantId, id, body.status);
  }

  @Post(':id/candidates/refresh')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Rebuild the candidate ledger from the linked reviewed/corrected ' +
      'sources (references only — source records are never mutated)',
  })
  refresh(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.datasets.refreshCandidates(tenantId, id);
  }

  @Get(':id/candidates')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Candidate rows (optionally by eligibility)' })
  candidates(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Query('eligibility') eligibility?: string,
  ) {
    let filter: CvDatasetEligibility | undefined;
    if (eligibility !== undefined && eligibility !== '') {
      if (
        eligibility !== CvDatasetEligibility.ELIGIBLE &&
        eligibility !== CvDatasetEligibility.EXCLUDED
      ) {
        throw new BadRequestException(
          'eligibility must be ELIGIBLE or EXCLUDED',
        );
      }
      filter = eligibility;
    }
    return this.datasets.listCandidates(tenantId, id, filter);
  }

  @Get(':id/quality-report')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Honest dataset quality report: coverage, imbalance/leakage ' +
      'warnings, and controlled next actions. Missing data is ' +
      'null/zero — never fabricated.',
  })
  qualityReport(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.datasets.qualityReport(tenantId, id);
  }

  @Post(':id/plan-splits')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Deterministic train/validation/test split plan (same live ' +
      'session stays together; low-coverage classes are forced into ' +
      'TRAIN with a warning)',
  })
  planSplits(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.datasets.planSplits(tenantId, id);
  }

  @Post(':id/export-manifest')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'Safe JSON export manifest for OFFLINE tuning (references, labels, ' +
      'and controlled metadata only — no media, paths, URLs, credentials, ' +
      'or model weights). Stamps the run EXPORTED.',
  })
  exportManifest(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.datasets.exportManifest(tenantId, id);
  }

  @Get(':id/model-tuning-report')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'ADVISORY model tuning recommendations. No training is invoked, no ' +
      'external model API is called, and no accuracy projection is made.',
  })
  modelTuningReport(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ) {
    return this.datasets.modelTuningReport(tenantId, id);
  }
}

@Module({
  imports: [PlatformModulesModule, PilotEvaluationModule],
  controllers: [CvDatasetController],
  providers: [CvDatasetService],
})
export class CvDatasetModule {}
