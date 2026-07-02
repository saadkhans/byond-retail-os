import { Module } from '@nestjs/common';
import { PermissionsRepository } from './permissions.repository';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

// Service-level only in Phase 1: no controller until auth exists.
@Module({
  providers: [RolesService, RolesRepository, PermissionsRepository],
  exports: [RolesService, PermissionsRepository],
})
export class AccessControlModule {}
