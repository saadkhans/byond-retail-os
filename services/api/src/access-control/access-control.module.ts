import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { PermissionsRepository } from './permissions.repository';
import { RolesController } from './roles.controller';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

// UsersModule is imported for tenant-scoped user validation during role
// assignment (target user and assigning actor must belong to the tenant).
@Module({
  imports: [UsersModule],
  controllers: [RolesController],
  providers: [RolesService, RolesRepository, PermissionsRepository],
  exports: [RolesService, PermissionsRepository],
})
export class AccessControlModule {}
