import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { PermissionsRepository } from './permissions.repository';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

// Service-level only in Phase 1: no controller until auth exists.
// UsersModule is imported for tenant-scoped user validation during role
// assignment (target user and assigning actor must belong to the tenant).
@Module({
  imports: [UsersModule],
  providers: [RolesService, RolesRepository, PermissionsRepository],
  exports: [RolesService, PermissionsRepository],
})
export class AccessControlModule {}
