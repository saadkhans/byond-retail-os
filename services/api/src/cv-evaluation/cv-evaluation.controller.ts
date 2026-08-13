import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import { CurrentTenantId } from '../auth/decorators/request-context.decorators';
import { CvEvaluationService } from './cv-evaluation.service';

/**
 * Phase 11 CV evaluation dashboard — READ-ONLY. Accuracy metrics cover
 * ONLY clips with saved ground truth; fused scores are uncalibrated
 * ranking scores (every response says so via scoreNote).
 */
@ApiTags('cv-evaluation')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('video-ingest')
@Controller('cv-evaluation')
export class CvEvaluationController {
  constructor(private readonly evaluation: CvEvaluationService) {}

  @Get('summary')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary:
      'Evaluation metrics over ground-truthed clips: pickup/return ' +
      'accuracy, false-touch rejection, SKU top-1/top-3, VLM agreement, ' +
      'human-review rate, basket exact match, per-stage median latency, ' +
      'per-SKU and per-test-type breakdowns',
  })
  summary(@CurrentTenantId() tenantId: string) {
    return this.evaluation.summary(tenantId);
  }

  @Get('test-runs')
  @RequirePermissions('video-asset:read')
  @ApiOperation({
    summary:
      'Controlled test matrix: one row per ground-truthed clip with its ' +
      'latest fusion shadow run and pass/fail against the labeled scenario',
  })
  testRuns(@CurrentTenantId() tenantId: string) {
    return this.evaluation.testRuns(tenantId);
  }
}
