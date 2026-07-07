import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role, UserRole } from '@prisma/client';
import {
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiBearerAuth()
@TenantOnly()
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @RequirePermissions('role:manage')
  @ApiOperation({ summary: 'Create a custom role in the caller’s tenant' })
  @ApiCreatedResponse({ description: 'Role created' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateRoleDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<Role> {
    return this.rolesService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('role:read')
  @ApiOperation({ summary: 'List roles in the caller’s tenant' })
  findMany(@CurrentTenantId() tenantId: string): Promise<Role[]> {
    return this.rolesService.findMany(tenantId);
  }

  @Post(':id/assign')
  @RequirePermissions('role:manage')
  @ApiOperation({ summary: 'Assign a tenant role to a tenant user' })
  assign(
    @CurrentTenantId() tenantId: string,
    @Param('id') roleId: string,
    @Body() dto: AssignRoleDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<UserRole> {
    // The authenticated caller is always the assigning actor; both actor and
    // target are re-verified against the tenant inside the repository.
    return this.rolesService.assignToUser(
      tenantId,
      dto.userId,
      roleId,
      actor.userId,
    );
  }
}
