import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
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
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { CvTestProtocolService } from './cv-test-protocol.service';
import {
  AddTestScenarioDto,
  CreateTestProtocolDto,
  LinkEvaluationRunDto,
  RecordScenarioResultDto,
  SetTestProtocolStatusDto,
} from './dto/cv-test-protocol.dto';
import {
  AttachEvaluationSessionDto,
  CreateEvaluationRunDto,
  ReviewObservationDto,
  SetEvaluationStatusDto,
} from './dto/pilot-evaluation.dto';
import { PilotEvaluationService } from './pilot-evaluation.service';

/**
 * Phase 15 — live pilot EVALUATION loop, SHADOW ONLY. Evaluation runs
 * group live sessions for accuracy/speed measurement; operator reviews
 * are append-only labels; the dataset export emits controlled JSONL.
 * No route here touches checkout, orders, payments, or inventory, and
 * no response carries URL, file path, or credential material.
 */
@ApiTags('pilot-evaluation')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('pilot-evaluations')
export class PilotEvaluationController {
  constructor(private readonly evaluations: PilotEvaluationService) {}

  @Post()
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Create a pilot evaluation run (OPEN)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() body: CreateEvaluationRunDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.evaluations.createRun(
      tenantId,
      {
        name: body.name,
        description: body.description,
        locationId: body.locationId,
      },
      actor.userId,
    );
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Pilot evaluation runs (newest first)' })
  list(@CurrentTenantId() tenantId: string) {
    return this.evaluations.listRuns(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Evaluation run detail with attached sessions' })
  detail(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.evaluations.runDetail(tenantId, id);
  }

  @Post(':id/status')
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Close a run: OPEN → COMPLETED / CANCELLED' })
  setStatus(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: SetEvaluationStatusDto,
  ) {
    return this.evaluations.setStatus(tenantId, id, body.status);
  }

  @Post(':id/sessions')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary: 'Attach a live session to an OPEN run (idempotent)',
  })
  attach(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: AttachEvaluationSessionDto,
  ) {
    return this.evaluations.attachSession(tenantId, id, body.liveSessionId);
  }

  @Get(':id/observations')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Live CV observations of the attached sessions, each with its ' +
      'latest pilot review (older reviews remain as audit history)',
  })
  observations(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.evaluations.observations(tenantId, id);
  }

  @Post(':id/reviews')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'APPEND one operator review/correction over a live observation ' +
      '(or a MISSED_EVENT attribution). Append-only: the observation is ' +
      'never rewritten and no inventory/billing state is touched.',
  })
  review(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: ReviewObservationDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.evaluations.reviewObservation(
      tenantId,
      id,
      {
        verdict: body.verdict,
        expectedAction: body.expectedAction,
        journeyEventId: body.journeyEventId,
        liveSessionId: body.liveSessionId,
        expectedProductId: body.expectedProductId,
        notes: body.notes,
      },
      actor.userId,
    );
  }

  @Get(':id/summary')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Accuracy, confusion, latency, and zero-mutation safety summary. ' +
      'Rates are null when their denominator is zero — never fabricated.',
  })
  summary(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.evaluations.summary(tenantId, id);
  }

  @Get(':id/dataset-export')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      'JSONL dataset manifest of operator-confirmed/corrected live ' +
      'observations. Controlled ids/enums/numbers only — no URLs, ' +
      'paths, credentials, pixels, or exception text.',
  })
  datasetExport(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.evaluations.datasetExport(tenantId, id);
  }
}

/**
 * Phase 16 — CV test protocols (SHADOW ONLY): scripted real-footage test
 * scenarios with expected outcomes, wrapped around the Phase 15
 * evaluation loop. Organizational + reporting only; no CV decision reads
 * protocol state, and no route touches checkout/order/payment/inventory.
 */
@ApiTags('cv-test-protocols')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('cv')
@Controller('cv-test-protocols')
export class CvTestProtocolController {
  constructor(private readonly protocols: CvTestProtocolService) {}

  @Post()
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Create a CV test protocol (DRAFT)' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() body: CreateTestProtocolDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.protocols.createProtocol(
      tenantId,
      {
        name: body.name,
        description: body.description,
        locationId: body.locationId,
        cameraSourceId: body.cameraSourceId,
        evaluationRunId: body.evaluationRunId,
        fastModeExpected: body.fastModeExpected,
      },
      actor.userId,
    );
  }

  @Get()
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'CV test protocols (newest first)' })
  list(@CurrentTenantId() tenantId: string) {
    return this.protocols.listProtocols(tenantId);
  }

  @Get(':id')
  @RequirePermissions('vision:read')
  @ApiOperation({ summary: 'Protocol detail with its scenario checklist' })
  detail(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.protocols.protocolDetail(tenantId, id);
  }

  @Post(':id/status')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary: 'DRAFT → ACTIVE; DRAFT/ACTIVE → COMPLETED / CANCELLED',
  })
  setStatus(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: SetTestProtocolStatusDto,
  ) {
    return this.protocols.setStatus(tenantId, id, body.status);
  }

  @Post(':id/evaluation-run')
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Link the evaluation run this protocol reports over' })
  linkRun(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: LinkEvaluationRunDto,
  ) {
    return this.protocols.linkEvaluationRun(
      tenantId,
      id,
      body.evaluationRunId,
    );
  }

  @Post(':id/scenarios')
  @RequirePermissions('vision:review')
  @ApiOperation({ summary: 'Add one scripted scenario to the checklist' })
  addScenario(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: AddTestScenarioDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.protocols.addScenario(
      tenantId,
      id,
      {
        scenarioType: body.scenarioType,
        expectedAction: body.expectedAction,
        expectedProductId: body.expectedProductId,
        expectedQuantity: body.expectedQuantity,
        notes: body.notes,
      },
      actor.userId,
    );
  }

  @Post(':id/scenarios/:scenarioId/result')
  @RequirePermissions('vision:review')
  @ApiOperation({
    summary:
      "Record the operator's PASS/FAIL/INCONCLUSIVE for one scenario " +
      '(reporting only — never a CV input)',
  })
  recordResult(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('scenarioId') scenarioId: string,
    @Body() body: RecordScenarioResultDto,
    @CurrentUser() actor: RequestContext,
  ) {
    return this.protocols.recordScenarioResult(
      tenantId,
      id,
      scenarioId,
      {
        result: body.result,
        liveSessionId: body.liveSessionId,
        resultNotes: body.resultNotes,
      },
      actor.userId,
    );
  }

  @Get(':id/report')
  @RequirePermissions('vision:read')
  @ApiOperation({
    summary:
      'Validation report: scenario pass/fail counts + the linked ' +
      "evaluation run's honest metrics + detection recall + fast-mode " +
      'observation + dataset availability. Missing data is null — never ' +
      'fabricated.',
  })
  report(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.protocols.report(tenantId, id);
  }
}

@Module({
  imports: [PlatformModulesModule],
  controllers: [PilotEvaluationController, CvTestProtocolController],
  providers: [PilotEvaluationService, CvTestProtocolService],
})
export class PilotEvaluationModule {}
