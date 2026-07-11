import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
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
  DevicesService,
  IssuedRegistrationToken,
} from './devices.service';
import { DeviceWithUnit } from './devices.repository';
import { CreateDeviceDto } from './dto/create-device.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { QueryDevicesDto } from './dto/query-devices.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(). A tenantId in the request body is rejected by the
// global whitelist ValidationPipe (forbidNonWhitelisted).
@ApiTags('devices')
@ApiBearerAuth()
@TenantOnly()
@RequireModule('devices')
@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Post()
  @RequirePermissions('device:manage')
  @ApiOperation({
    summary: 'Register (provision) a device on a retail unit',
    description:
      'Serial number is unique per tenant and immutable. `metadata` is for ' +
      'SAFE, NON-SECRET configuration only. Devices start PROVISIONED ' +
      'unless another status is given.',
  })
  @ApiCreatedResponse({ description: 'Device created' })
  @ApiConflictResponse({ description: 'Duplicate serial number' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateDeviceDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<DeviceWithUnit> {
    return this.devicesService.create(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get()
  @RequirePermissions('device:read')
  @ApiOperation({
    summary: 'Search devices in the caller’s tenant',
    description:
      'Filters: free-text search (name/serial, case-insensitive), unit, ' +
      'type, status. Paginated via skip/take with a deterministic order ' +
      '(name, then id).',
  })
  search(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryDevicesDto,
  ): Promise<{
    items: DeviceWithUnit[];
    total: number;
    skip: number;
    take: number;
  }> {
    return this.devicesService.search(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('device:read')
  @ApiOperation({ summary: 'Get a device with its unit' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  findById(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<DeviceWithUnit> {
    return this.devicesService.findById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('device:manage')
  @ApiOperation({
    summary: 'Update a device',
    description:
      'The serial number is immutable and RETIRED is terminal. lastSeenAt ' +
      'is never client-writable — only heartbeats and registration set it. ' +
      'Status changes are audited with before/after snapshots.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Device is RETIRED (terminal)' })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<DeviceWithUnit> {
    return this.devicesService.update(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('device:manage')
  @ApiOperation({ summary: 'Delete a device' })
  @ApiNoContentResponse({ description: 'Device deleted' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  async delete(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<void> {
    await this.devicesService.delete(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/heartbeat')
  @HttpCode(200)
  @RequirePermissions('device:heartbeat')
  @ApiOperation({
    summary: 'Record a device heartbeat',
    description:
      'Bumps lastSeenAt (server clock), optionally refreshes firmware/' +
      'software versions, and promotes PROVISIONED/OFFLINE devices to ' +
      'ONLINE. MAINTENANCE devices keep their status; DISABLED/RETIRED ' +
      'devices are refused (409). Status transitions are audited.',
  })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Device is DISABLED or RETIRED' })
  heartbeat(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: HeartbeatDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<DeviceWithUnit> {
    return this.devicesService.heartbeat(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/registration-token')
  @HttpCode(201)
  @RequirePermissions('device:register')
  @ApiOperation({
    summary: 'Issue a one-time edge registration token for a device',
    description:
      'Returns the plaintext token EXACTLY ONCE — only its SHA-256 hash is ' +
      'stored, and neither the token nor the hash is ever logged or ' +
      'audited. The token is bound to the device’s serial number, ' +
      'single-use, and expires after 60 minutes. Reissuing invalidates any ' +
      'previously issued token. The edge device redeems it via ' +
      'POST /edge/register.',
  })
  @ApiCreatedResponse({ description: 'Token issued (returned once)' })
  @ApiNotFoundResponse({ description: 'Not found in this tenant' })
  @ApiConflictResponse({ description: 'Device is DISABLED or RETIRED' })
  issueRegistrationToken(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: RequestContext,
  ): Promise<IssuedRegistrationToken> {
    return this.devicesService.issueRegistrationToken(tenantId, id, {
      id: actor.userId,
      email: actor.email,
    });
  }
}
