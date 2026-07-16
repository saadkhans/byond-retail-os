import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
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
import { QueryReconciliationDto } from './dto/query-reconciliation.dto';
import { UpdateReconciliationDto } from './dto/update-reconciliation.dto';
import { ReconciliationWithRefs } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';

/**
 * Reconciliation FOUNDATION — read models plus a manual status update. There
 * is NO settlement accounting, NO provider reconciliation import, and NO Zoho
 * integration in this phase. A PENDING record is seeded whenever a payment is
 * captured; provider settlement matching arrives with the gateway adapters.
 */
@ApiTags('reconciliation')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('payments')
@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
  ) {}

  @Get('records')
  @RequirePermissions('reconciliation:read')
  @ApiOperation({
    summary: 'List reconciliation records in the caller’s tenant',
    description:
      'Filters: status, intent. Deterministic ordering (newest first, id ' +
      'tie-breaker), paginated.',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryReconciliationDto,
  ): Promise<{
    items: ReconciliationWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.reconciliationService.search(tenantId, query);
  }

  @Get('records/:id')
  @RequirePermissions('reconciliation:read')
  @ApiOperation({ summary: 'Get a reconciliation record' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ReconciliationWithRefs> {
    return this.reconciliationService.findById(tenantId, id);
  }

  @Patch('records/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reconciliation:manage')
  @ApiOperation({
    summary: 'Update a reconciliation record’s status (manual, no accounting)',
    description:
      'Marks a record MATCHED/MISMATCH/RECONCILED/FAILED. RECONCILED is ' +
      'terminal. No settlement accounting or provider import — this is a ' +
      'manual/foundation action only.',
  })
  @ApiOkResponse({ description: 'Reconciliation record updated' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Record is RECONCILED (terminal)' })
  updateStatus(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReconciliationDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<ReconciliationWithRefs> {
    return this.reconciliationService.updateStatus(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
