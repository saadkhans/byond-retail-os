import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { SafeUser, toSafeUser } from '../auth/safe-user';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersService } from './users.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(). A tenantId in the request body is rejected by the
// global whitelist ValidationPipe (forbidNonWhitelisted).
@ApiTags('users')
@ApiBearerAuth()
@TenantOnly()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @RequirePermissions('user:manage')
  @ApiOperation({ summary: 'Create a user in the caller’s tenant' })
  @ApiCreatedResponse({ description: 'User created (no credential yet)' })
  async create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<SafeUser> {
    const user = await this.usersService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
    return toSafeUser(user);
  }

  @Get()
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'List users in the caller’s tenant' })
  async findMany(@CurrentTenantId() tenantId: string): Promise<SafeUser[]> {
    const users = await this.usersService.findMany(tenantId);
    return users.map(toSafeUser);
  }

  @Get(':id')
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'Get a user in the caller’s tenant' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  async findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<SafeUser> {
    return toSafeUser(await this.usersService.findById(tenantId, id));
  }
}
